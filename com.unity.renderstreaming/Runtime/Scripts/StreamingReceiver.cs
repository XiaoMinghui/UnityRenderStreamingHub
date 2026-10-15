using System;
using System.Collections;
using System.Threading;
using Unity.RenderStreaming.Signaling;
using Unity.WebRTC;
using UnityEngine;

namespace Unity.RenderStreaming
{
    public enum StreamingReceiverState { Stopped, Connecting, WaitingForStream, Streaming, Reconnecting, Error }

    /// <summary>A reusable native receiver for the public WebSocket/Broadcast workflow.</summary>
    [DisallowMultipleComponent]
    public sealed class StreamingReceiver : MonoBehaviour
    {
        [SerializeField] private string signalingUrl = "ws://localhost:8080";
        [SerializeField] private bool startOnEnable = true;
        [SerializeField, Min(5)] private float firstFrameTimeout = 30;
        [SerializeField, Min(2)] private float frameTimeout = 8;
        private Coroutine worker;
        private Coroutine healthMonitor;
        private GameObject runtimeRoot;
        private SignalingManager manager;
        private WebSocketSignaling signaling;
        private SingleConnection connection;
        private VideoStreamReceiver video;
        private InputSender input;
        private bool requested, paused;
        private string failure;
        private float lastFrameTime;
        private float lastReceivedTime;

        public string SignalingUrl { get => signalingUrl; set => signalingUrl = value; }
        public StreamingReceiverState State { get; private set; }
        public string StatusMessage { get; private set; } = "Stopped";
        public Texture Texture => video != null ? video.texture : null;
        public long DecodedFrames { get; private set; }
        public bool IsInputConnected => input != null && input.IsConnected;
        public event Action<StreamingReceiverState, string> StateChanged;
        public event Action<Texture> TextureUpdated;

        private void OnEnable() { if (startOnEnable) StartReceiving(); }

        public void StartReceiving()
        {
            requested = true;
            if (!Application.isPlaying || !isActiveAndEnabled || paused || worker != null) return;
            if (!Uri.TryCreate(signalingUrl, UriKind.Absolute, out var uri) ||
                (uri.Scheme != "ws" && uri.Scheme != "wss"))
            {
                SetState(StreamingReceiverState.Error, "Configure a ws:// or wss:// signaling URL.");
                return;
            }
            worker = StartCoroutine(ReceiveLoop());
        }

        public void StopReceiving()
        {
            requested = false;
            StopWorker();
            SetState(StreamingReceiverState.Stopped, "Stopped");
        }

        public void Retry() { StopWorker(); StartReceiving(); }

        public void SetInputRegion(Rect screenRegion, Vector2Int videoSize)
        {
            if (input == null || !input.IsConnected || screenRegion.width <= 0 || screenRegion.height <= 0) return;
            input.CalculateInputResion(screenRegion, videoSize);
            input.EnableInputPositionCorrection(true);
        }

        private IEnumerator ReceiveLoop()
        {
            // Let UI subscribers and platform initialization finish before negotiation.
            yield return null;
            int attempts = 0;
            while (requested && !paused)
            {
                failure = null;
                bool created = false;
                try { CreateRuntime(); created = true; }
                catch (Exception error) { SetState(StreamingReceiverState.Error, error.Message); }
                if (!created) { Cleanup(); worker = null; yield break; }
                bool registered = false, hadFrame = false;
                float waitingSince = Time.realtimeSinceStartup;
                while (requested && !paused && failure == null)
                {
                    float now = Time.realtimeSinceStartup;
                    if (!signaling.IsConnected)
                    {
                        registered = false;
                        var reconnecting = signaling.ConnectionState == SignalingConnectionState.Reconnecting;
                        SetState(reconnecting ? StreamingReceiverState.Reconnecting : StreamingReceiverState.Connecting,
                            reconnecting ? "Signaling unavailable; retrying automatically." : "Connecting to signaling server...");
                    }
                    else
                    {
                        if (!registered)
                        {
                            connection.CreateConnection(Guid.NewGuid().ToString("N"));
                            registered = true;
                            hadFrame = false;
                            waitingSince = now;
                            SetState(StreamingReceiverState.WaitingForStream, "Server connected; waiting for the sender...");
                        }
                        if (Texture != null && lastFrameTime > waitingSince)
                        {
                            hadFrame = true;
                            attempts = 0;
                            SetState(StreamingReceiverState.Streaming, "Streaming");
                        }
                        if (!hadFrame && now - waitingSince > firstFrameTimeout)
                            failure = "No video frame arrived. Check the sender and network.";
                        else if (hadFrame && now - lastFrameTime > frameTimeout)
                            failure = now - lastReceivedTime > frameTimeout
                                ? "Video data reception stopped." : "Video decoding stopped while data is arriving.";
                    }
                    yield return null;
                }
                Cleanup();
                if (!requested || paused) break;
                float delay = Mathf.Min(15, Mathf.Pow(2, Mathf.Min(attempts++, 4)));
                SetState(StreamingReceiverState.Reconnecting, $"{failure} Retrying in {delay:0}s...");
                yield return new WaitForSecondsRealtime(delay);
            }
            worker = null;
        }

        private void CreateRuntime()
        {
            SetState(StreamingReceiverState.Connecting, "Connecting to signaling server...");
            lastFrameTime = -1;
            lastReceivedTime = -1;
            var root = runtimeRoot = new GameObject("Streaming Receiver Runtime");
            root.transform.SetParent(transform, false);
            root.SetActive(false);
            connection = root.AddComponent<SingleConnection>();
            video = root.AddComponent<VideoStreamReceiver>();
            var audio = root.AddComponent<AudioStreamReceiver>();
            var audioSource = root.AddComponent<AudioSource>();
            audioSource.playOnAwake = false;
            audio.targetAudioSource = audioSource;
            audio.OnUpdateReceiveAudioSource += source => {
                if (runtimeRoot != root || source == null) return;
                source.loop = true; source.Play();
            };
            video.OnUpdateReceiveTexture += texture => {
                if (runtimeRoot != root) return;
                TextureUpdated?.Invoke(texture);
            };
            input = root.AddComponent<InputSender>();
            input.ConfigureInputChannel();
            input.OnStoppedChannel += _ => { if (runtimeRoot == root) failure = "Remote input channel disconnected."; };
            connection.AddComponent(video);
            connection.AddComponent(audio);
            connection.AddComponent(input);
            manager = root.AddComponent<SignalingManager>();
            manager.runOnAwake = false;
            manager.evaluateCommandlineArguments = false;
            manager.useDefaultSettings = false;
            var settings = new WebSocketSignalingSettings(signalingUrl);
            manager.SetSignalingSettings(settings);
            manager.AddSignalingHandler(connection);
            signaling = new WebSocketSignaling(settings, SynchronizationContext.Current);
            root.SetActive(true);
            manager.Run(signaling);
            healthMonitor = StartCoroutine(MonitorFrames(root));
        }

        private IEnumerator MonitorFrames(GameObject root)
        {
            uint previousFrames = 0;
            ulong previousBytes = 0;
            while (runtimeRoot == root)
            {
                yield return new WaitForSecondsRealtime(1);
                if (video == null || video.Transceiver == null) continue;
                RTCStatsReportAsyncOperation operation = null;
                try { operation = video.Transceiver.Receiver.GetStats(); }
                catch (Exception) { failure = "Unable to read video connection statistics."; }
                if (operation == null) yield break;
                float deadline = Time.realtimeSinceStartup + 5;
                while (!operation.IsDone && Time.realtimeSinceStartup < deadline) yield return null;
                if (!operation.IsDone || operation.IsError) { failure = "Video connection statistics timed out."; yield break; }
                using (var report = operation.Value)
                {
                    foreach (var stat in report.Stats.Values)
                    {
                        if (!(stat is RTCInboundRTPStreamStats inbound) || inbound.kind != "video") continue;
                        float now = Time.realtimeSinceStartup;
                        if (inbound.framesDecoded > previousFrames) {
                            DecodedFrames += inbound.framesDecoded - previousFrames;
                            lastFrameTime = now;
                        }
                        if (inbound.bytesReceived > previousBytes) lastReceivedTime = now;
                        previousFrames = inbound.framesDecoded;
                        previousBytes = inbound.bytesReceived;
                    }
                }
            }
        }

        private void Cleanup()
        {
            if (healthMonitor != null) StopCoroutine(healthMonitor);
            healthMonitor = null;
            var root = runtimeRoot;
            runtimeRoot = null;
            manager?.Stop();
            manager = null; signaling = null; connection = null; video = null; input = null;
            TextureUpdated?.Invoke(null);
            if (root != null) { root.SetActive(false); Destroy(root); }
        }

        private void StopWorker()
        {
            if (worker != null) StopCoroutine(worker);
            worker = null;
            Cleanup();
        }

        private void SetState(StreamingReceiverState state, string message)
        {
            if (State == state && StatusMessage == message) return;
            State = state; StatusMessage = message;
            StateChanged?.Invoke(state, message);
        }

        private void OnApplicationPause(bool value)
        {
            paused = value;
            if (value) { StopWorker(); SetState(StreamingReceiverState.Stopped, "Suspended"); }
            else if (requested) StartReceiving();
        }

        private void OnDisable() => StopReceiving();
    }
}
