using System;
using System.Threading;
using Unity.RenderStreaming.Signaling;
using UnityEngine;
using UnityEngine.Events;

namespace Unity.RenderStreaming
{
    /// <summary>Runs an existing Broadcast sender in the optional instance pool.</summary>
    [DisallowMultipleComponent]
    [AddComponentMenu("Render Streaming/Pool Sender")]
    public sealed class PoolSender : MonoBehaviour
    {
        [SerializeField] private SignalingManager manager;
        [SerializeField] private Broadcast sender;
        [SerializeField] private string signalingUrl = "ws://localhost:8080/pool";
        [SerializeField] private string instanceId = "";
        [SerializeField] private string poolId = "default";
        [SerializeField] private bool startOnEnable = true;
        [SerializeField, Tooltip("Only enable for applications that need no per-user scene or data reset.")]
        private bool automaticallyReady;
        [SerializeField] private UnityEvent<string> resetRequested = new UnityEvent<string>();
        private PoolSenderSignaling signaling;
        private bool requested, paused;
        private string processId;

        public string SignalingUrl { get => signalingUrl; set => signalingUrl = value; }
        public string InstanceId { get => instanceId; set => instanceId = value; }
        public string PoolId { get => poolId; set => poolId = value; }
        public string SenderToken { get; set; }
        public bool AutomaticallyReady { get => automaticallyReady; set => automaticallyReady = value; }
        public bool Running => signaling != null;
        public event Action<string> ResetRequested;

        private void OnEnable() { if (startOnEnable) StartSending(); }

        public void StartSending()
        {
            requested = true;
            if (!Application.isPlaying || !isActiveAndEnabled || paused || signaling != null) return;
            if (manager == null || sender == null) throw new InvalidOperationException("Assign the sender's SignalingManager and Broadcast.");
            if (manager.Running) throw new InvalidOperationException("Disable SignalingManager Run On Awake; PoolSender must own its signaling lifecycle.");
            if (string.IsNullOrEmpty(processId)) processId = Guid.NewGuid().ToString("N");
            var transport = new PoolSenderSignaling(signalingUrl,
                string.IsNullOrEmpty(instanceId) ? processId : instanceId, poolId,
                SenderToken ?? Environment.GetEnvironmentVariable("RENDERSTREAMING_POOL_TOKEN"), SynchronizationContext.Current);
            transport.ResetRequested += ticket => {
                if (signaling != transport) return;
                ResetRequested?.Invoke(ticket);
                resetRequested.Invoke(ticket);
                if (automaticallyReady) CompleteReset(ticket);
            };
            transport.Error += message => Debug.LogWarning("Render Streaming instance pool: " + message, this);
            manager.AddSignalingHandler(sender);
            signaling = transport;
            try { manager.Run(transport); }
            catch { signaling = null; transport.Stop(); throw; }
        }

        /// <summary>Acknowledge this specific reset ticket after project-owned reset completes.</summary>
        public void CompleteReset(string resetId) => signaling?.CompleteReset(resetId);

        public void StopSending()
        {
            requested = false;
            StopRuntime();
        }

        private void StopRuntime()
        {
            if (signaling == null) return;
            // Clear handler-owned transceivers/input before disposing the manager.
            // SignalingManager.Stop itself retains its existing legacy behavior.
            if (!string.IsNullOrEmpty(signaling.ConnectionId))
                sender.OnDeletedConnection(new SignalingEventData(null) { connectionId = signaling.ConnectionId });
            manager.Stop();
            signaling = null;
        }

        private void OnApplicationPause(bool value)
        {
            paused = value;
            if (value) StopRuntime();
            else if (requested) StartSending();
        }

        private void OnDisable() => StopSending();
    }
}
