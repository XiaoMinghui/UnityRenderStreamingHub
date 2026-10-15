using System;
using System.Diagnostics;
using System.Security.Authentication;
using System.Threading;
using Unity.WebRTC;
using UnityEngine;
using WebSocketSharp;

namespace Unity.RenderStreaming.Signaling
{
    /// <summary>Opt-in sender transport for the isolated /pool endpoint.</summary>
    public sealed class PoolSenderSignaling : ISignaling
    {
        [Serializable]
        private class Data
        {
            public string connectionId, sdp, candidate, sdpMid;
            public int sdpMLineIndex;
            public bool polite;
        }

        [Serializable]
        private class Message
        {
            public string type, connectionId, leaseId, resetId, instanceId, poolId, token, message, reason, from;
            public Data data;
        }

        private readonly SynchronizationContext context;
        private readonly string instanceId, poolId, token;
        private readonly AutoResetEvent wake = new AutoResetEvent(false);
        private readonly object gate = new object();
        private volatile bool running;
        private int generation;
        private WebSocket socket;
        private Thread worker;
        private string connectionId, leaseId, pendingReset;
        public string Url { get; }
        public string ConnectionId => connectionId;
        public bool IsConnected => socket != null && socket.ReadyState == WebSocketState.Open;
        public event OnStartHandler OnStart;
#pragma warning disable 0067
        // Pool senders create peers from routed offers, not explicit connect events.
        public event OnConnectHandler OnCreateConnection;
#pragma warning restore 0067
        public event OnDisconnectHandler OnDestroyConnection;
        public event OnOfferHandler OnOffer;
        public event OnAnswerHandler OnAnswer;
        public event OnIceCandidateHandler OnIceCandidate;
        /// <summary>Complete application reset before calling CompleteReset with this ticket.</summary>
        public event Action<string> ResetRequested;
        public event Action<string> Error;

        public PoolSenderSignaling(string url, string instanceId, string poolId, string token, SynchronizationContext context)
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
                (uri.Scheme != "ws" && uri.Scheme != "wss") || uri.AbsolutePath != "/pool")
                throw new ArgumentException("Use a ws:// or wss:// URL ending in /pool.", nameof(url));
            if (!ValidId(instanceId) || !ValidId(poolId)) throw new ArgumentException("Instance and pool IDs must use 1-128 letters, numbers, underscores, periods or hyphens.");
            if (string.IsNullOrEmpty(token)) throw new ArgumentException("Configure the pool sender token.", nameof(token));
            Url = url;
            this.instanceId = instanceId;
            this.poolId = poolId;
            this.token = token;
            this.context = context ?? throw new ArgumentNullException(nameof(context));
        }

        private static bool ValidId(string value) => !string.IsNullOrEmpty(value) &&
            System.Text.RegularExpressions.Regex.IsMatch(value, @"\A[a-zA-Z0-9_.-]{1,128}\z");

        public void Start()
        {
            if (running) throw new InvalidOperationException("Already started.");
            running = true;
            var current = Interlocked.Increment(ref generation);
            wake.Reset();
            worker = new Thread(() => Manage(current)) { IsBackground = true, Name = "Render Streaming pool sender" };
            worker.Start();
        }

        public void Stop()
        {
            WebSocket previous;
            lock (gate)
            {
                running = false;
                Interlocked.Increment(ref generation);
                previous = socket;
                socket = null;
                wake.Set();
            }
            try { previous?.CloseAsync(); } catch (Exception) { }
            if (worker != null && worker != Thread.CurrentThread) worker.Join(1000);
            worker = null;
            connectionId = leaseId = pendingReset = null;
        }

        private void Post(WebSocket source, int current, Action action)
        {
            context.Post(_ => {
                if (running && current == Volatile.Read(ref generation) && ReferenceEquals(socket, source)) action();
            }, null);
        }

        private void Manage(int current)
        {
            while (running && current == Volatile.Read(ref generation))
            {
                WebSocket source = null;
                try
                {
                    wake.Reset();
                    source = new WebSocket(Url) { WaitTime = TimeSpan.FromSeconds(3) };
                    if (Url.StartsWith("wss:")) source.SslConfiguration.EnabledSslProtocols = SslProtocols.Tls12;
                    var activeSocket = source;
                    source.OnOpen += (_, __) => Post(activeSocket, current, () => {
                        connectionId = leaseId = pendingReset = null;
                        OnStart?.Invoke(this); // The manager releases peers from the previous socket first.
                        Send(new Message { type = "register", instanceId = instanceId, poolId = poolId, token = token });
                    });
                    source.OnMessage += (_, e) => {
                        if (e.IsText) Post(activeSocket, current, () => Receive(e.Data));
                    };
                    source.OnError += (_, __) => { if (ReferenceEquals(socket, activeSocket)) wake.Set(); };
                    source.OnClose += (_, __) => { if (ReferenceEquals(socket, activeSocket)) wake.Set(); };
                    lock (gate)
                    {
                        if (!running || current != Volatile.Read(ref generation)) break;
                        socket = source;
                    }
                    source.ConnectAsync();
                    var elapsed = Stopwatch.StartNew();
                    double lastPing = 0;
                    while (running && current == Volatile.Read(ref generation))
                    {
                        if (wake.WaitOne(500)) break;
                        if (source.ReadyState == WebSocketState.Open)
                        {
                            if (elapsed.Elapsed.TotalSeconds - lastPing >= 15)
                            {
                                lastPing = elapsed.Elapsed.TotalSeconds;
                                if (!source.Ping()) break;
                            }
                        }
                        else if (source.ReadyState == WebSocketState.Closed || elapsed.Elapsed.TotalSeconds >= 10) break;
                    }
                }
                catch (Exception)
                {
                    if (source != null) Post(source, current, () => Error?.Invoke("Pool signaling connection failed."));
                }
                finally
                {
                    lock (gate) if (ReferenceEquals(socket, source)) socket = null;
                    try { source?.CloseAsync(); } catch (Exception) { }
                }
                if (!running || current != Volatile.Read(ref generation)) break;
                wake.WaitOne(5000);
            }
        }

        private void Receive(string json)
        {
            Message msg;
            try { msg = JsonUtility.FromJson<Message>(json); }
            catch (Exception) { Error?.Invoke("Invalid pool signaling message."); return; }
            if (msg == null) return;
            switch (msg.type)
            {
                case "reset":
                    connectionId = leaseId = null;
                    pendingReset = msg.resetId;
                    ResetRequested?.Invoke(msg.resetId);
                    return;
                case "assigned":
                    connectionId = msg.connectionId;
                    leaseId = msg.leaseId;
                    return;
                case "error":
                case "unavailable":
                    Error?.Invoke(msg.message ?? msg.reason);
                    return;
            }
            if (string.IsNullOrEmpty(leaseId) || msg.leaseId != leaseId ||
                (msg.connectionId ?? msg.from) != connectionId) return;
            switch (msg.type)
            {
                case "disconnect":
                    var previous = connectionId;
                    connectionId = leaseId = null;
                    OnDestroyConnection?.Invoke(this, previous);
                    break;
                case "offer":
                    if (msg.data != null) OnOffer?.Invoke(this, new DescData {
                        connectionId = connectionId, sdp = msg.data.sdp, polite = msg.data.polite
                    });
                    break;
                case "answer":
                    if (msg.data != null) OnAnswer?.Invoke(this, new DescData { connectionId = connectionId, sdp = msg.data.sdp });
                    break;
                case "candidate":
                    if (msg.data != null) OnIceCandidate?.Invoke(this, new CandidateData {
                        connectionId = connectionId, candidate = msg.data.candidate,
                        sdpMid = msg.data.sdpMid, sdpMLineIndex = msg.data.sdpMLineIndex
                    });
                    break;
            }
        }

        public void CompleteReset(string resetId)
        {
            if (string.IsNullOrEmpty(resetId) || pendingReset != resetId || !IsConnected) return;
            pendingReset = null;
            Send(new Message { type = "ready", resetId = resetId });
        }

        private void Send(Message message)
        {
            var source = socket;
            if (source == null || source.ReadyState != WebSocketState.Open) return;
            try { source.Send(JsonUtility.ToJson(message)); }
            catch (Exception) { if (ReferenceEquals(source, socket)) wake.Set(); }
        }

        public void OpenConnection(string id) => throw new NotSupportedException("The pool assigns sender connections.");

        public void CloseConnection(string id)
        {
            if (id == connectionId) Send(new Message { type = "disconnect", connectionId = id, leaseId = leaseId });
        }

        public void SendOffer(string id, RTCSessionDescription offer) => SendDescription("offer", id, offer.sdp);
        public void SendAnswer(string id, RTCSessionDescription answer) => SendDescription("answer", id, answer.sdp);

        private void SendDescription(string type, string id, string sdp)
        {
            if (id == connectionId) Send(new Message {
                type = type, leaseId = leaseId, data = new Data { connectionId = id, sdp = sdp }
            });
        }

        public void SendCandidate(string id, RTCIceCandidate candidate)
        {
            if (id == connectionId) Send(new Message {
                type = "candidate", leaseId = leaseId, data = new Data {
                    connectionId = id, candidate = candidate.Candidate,
                    sdpMid = candidate.SdpMid, sdpMLineIndex = candidate.SdpMLineIndex.GetValueOrDefault()
                }
            });
        }
    }
}
