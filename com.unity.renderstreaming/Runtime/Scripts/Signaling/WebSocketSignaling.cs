using System;
using System.Diagnostics;
using System.Security.Authentication;
using System.Text;
using System.Threading;
using Unity.WebRTC;
using UnityEngine;
using WebSocketSharp;

namespace Unity.RenderStreaming.Signaling
{
    public enum SignalingConnectionState { Stopped, Connecting, Connected, Reconnecting }

    public class WebSocketSignaling : ISignaling
    {

        private readonly string m_url;
        private readonly float m_timeout;
        private readonly SynchronizationContext m_mainThreadContext;
        private volatile bool m_running;
        private int m_generation;
        private volatile SignalingConnectionState m_state;
        public SignalingConnectionState ConnectionState => m_state;
        public bool IsConnected => m_state == SignalingConnectionState.Connected;
        public event Action<SignalingConnectionState> StateChanged;
        private Thread m_signalingThread;
        private readonly AutoResetEvent m_wsCloseEvent;
        private readonly object m_socketGate = new object();
        private WebSocket m_webSocket;

        public string Url { get { return m_url; } }

        public WebSocketSignaling(SignalingSettings signalingSettings, SynchronizationContext mainThreadContext)
        {
            if (signalingSettings == null)
                throw new ArgumentNullException(nameof(signalingSettings));
            if (!(signalingSettings is WebSocketSignalingSettings settings))
                throw new ArgumentException("signalingSettings is not WebSocketSignalingSettings");
            m_url = settings.url;
            m_timeout = 5.0f;
            m_mainThreadContext = mainThreadContext;
            m_wsCloseEvent = new AutoResetEvent(false);

        }

        public void Start()
        {
            if (m_running) throw new InvalidOperationException("This object is already started.");
            m_running = true;
            int generation = Interlocked.Increment(ref m_generation);
            m_wsCloseEvent.Reset();
            m_signalingThread = new Thread(() => WSManage(generation)) {
                IsBackground = true, Name = "Render Streaming signaling"
            };
            m_signalingThread.Start();
        }

        public void Stop()
        {
            WebSocket socket;
            int generation;
            lock (m_socketGate)
            {
                m_running = false;
                generation = Interlocked.Increment(ref m_generation);
                m_wsCloseEvent.Set();
                socket = m_webSocket;
                m_webSocket = null;
            }
            try { socket?.CloseAsync(); } catch (Exception) { }
            var thread = m_signalingThread;
            if (thread != null && thread != Thread.CurrentThread) thread.Join(1000);
            m_signalingThread = null;
            SetState(SignalingConnectionState.Stopped, generation);
        }

        private void SetState(SignalingConnectionState state, int generation)
        {
            if (generation != Volatile.Read(ref m_generation) || m_state == state) return;
            m_state = state;
            m_mainThreadContext.Post(_ => {
                if (generation == Volatile.Read(ref m_generation)) StateChanged?.Invoke(state);
            }, null);
        }

        private void Dispatch(Action action, object socket)
        {
            int generation = Volatile.Read(ref m_generation);
            m_mainThreadContext.Post(_ => {
                if (m_running && generation == Volatile.Read(ref m_generation) &&
                    ReferenceEquals(socket, m_webSocket)) action();
            }, null);
        }

        public event OnStartHandler OnStart;
        public event OnConnectHandler OnCreateConnection;
        public event OnDisconnectHandler OnDestroyConnection;
        public event OnOfferHandler OnOffer;
#pragma warning disable 0067
        // this event is never used in this class
        public event OnAnswerHandler OnAnswer;
#pragma warning restore 0067
        public event OnIceCandidateHandler OnIceCandidate;

        public void SendOffer(string connectionId, RTCSessionDescription offer)
        {
            DescData data = new DescData();
            data.connectionId = connectionId;
            data.sdp = offer.sdp;
            data.type = "offer";

            RoutedMessage<DescData> routedMessage = new RoutedMessage<DescData>();
            routedMessage.from = connectionId;
            routedMessage.data = data;
            routedMessage.type = "offer";

            WSSend(routedMessage);
        }

        public void SendAnswer(string connectionId, RTCSessionDescription answer)
        {
            DescData data = new DescData();
            data.connectionId = connectionId;
            data.sdp = answer.sdp;
            data.type = "answer";

            RoutedMessage<DescData> routedMessage = new RoutedMessage<DescData>();
            routedMessage.from = connectionId;
            routedMessage.data = data;
            routedMessage.type = "answer";

            WSSend(routedMessage);
        }

        public void SendCandidate(string connectionId, RTCIceCandidate candidate)
        {
            CandidateData data = new CandidateData();
            data.connectionId = connectionId;
            data.candidate = candidate.Candidate;
            data.sdpMLineIndex = candidate.SdpMLineIndex.GetValueOrDefault(0);
            data.sdpMid = candidate.SdpMid;

            RoutedMessage<CandidateData> routedMessage = new RoutedMessage<CandidateData>();
            routedMessage.from = connectionId;
            routedMessage.data = data;
            routedMessage.type = "candidate";

            WSSend(routedMessage);
        }

        public void OpenConnection(string connectionId)
        {
            this.WSSend($"{{\"type\":\"connect\", \"connectionId\":\"{connectionId}\"}}");
        }

        public void CloseConnection(string connectionId)
        {
            this.WSSend($"{{\"type\":\"disconnect\", \"connectionId\":\"{connectionId}\"}}");
        }

        private void WSManage(int generation)
        {
            bool first = true;
            while (m_running && generation == Volatile.Read(ref m_generation))
            {
                SetState(first ? SignalingConnectionState.Connecting : SignalingConnectionState.Reconnecting, generation);
                first = false;
                WebSocket socket = null;
                try
                {
                    m_wsCloseEvent.Reset();
                    socket = new WebSocket(m_url) { WaitTime = TimeSpan.FromSeconds(3) };
                    if (m_url.StartsWith("wss"))
                        socket.SslConfiguration.EnabledSslProtocols = SslProtocols.Tls12;
                    socket.OnOpen += WSConnected;
                    socket.OnMessage += WSProcessMessage;
                    socket.OnError += WSError;
                    socket.OnClose += WSClosed;
                    lock (m_socketGate)
                    {
                        if (!m_running || generation != Volatile.Read(ref m_generation)) break;
                        m_webSocket = socket;
                    }
                    socket.ConnectAsync();
                    var elapsed = Stopwatch.StartNew();
                    double lastPing = 0;
                    while (m_running && generation == Volatile.Read(ref m_generation))
                    {
                        if (m_wsCloseEvent.WaitOne(500)) break;
                        if (socket.ReadyState == WebSocketState.Open)
                        {
                            if (elapsed.Elapsed.TotalSeconds - lastPing >= 15)
                            {
                                lastPing = elapsed.Elapsed.TotalSeconds;
                                if (!socket.Ping()) break;
                            }
                        }
                        else if (socket.ReadyState == WebSocketState.Closed || elapsed.Elapsed.TotalSeconds >= 10)
                            break;
                    }
                }
                catch (Exception error)
                {
                    RenderStreaming.Logger.Log(LogType.Warning, "Signaling connection: " + error.Message);
                }
                finally
                {
                    lock (m_socketGate)
                        if (ReferenceEquals(m_webSocket, socket)) m_webSocket = null;
                    if (socket != null)
                    {
                        socket.OnOpen -= WSConnected;
                        socket.OnMessage -= WSProcessMessage;
                        socket.OnError -= WSError;
                        socket.OnClose -= WSClosed;
                        try { socket.CloseAsync(); } catch (Exception) { }
                    }
                }
                if (!m_running || generation != Volatile.Read(ref m_generation)) break;
                SetState(SignalingConnectionState.Reconnecting, generation);
                // Interruptible delay. Stop wakes this single worker; no second retry loop is needed.
                m_wsCloseEvent.WaitOne((int)(m_timeout * 1000));
            }
        }

        private void WSProcessMessage(object sender, MessageEventArgs e)
        {
            if (!m_running || !ReferenceEquals(sender, m_webSocket) || !e.IsText) return;
            var content = Encoding.UTF8.GetString(e.RawData);
            RenderStreaming.Logger.Log($"Signaling: Receiving message: {content}");

            try
            {
                var routedMessage = JsonUtility.FromJson<RoutedMessage<SignalingMessage>>(content);

                SignalingMessage msg;
                if (!string.IsNullOrEmpty(routedMessage.type))
                {
                    msg = routedMessage.data;
                }
                else
                {
                    msg = JsonUtility.FromJson<SignalingMessage>(content);
                }

                if (!string.IsNullOrEmpty(routedMessage.type))
                {
                    if (routedMessage.type == "connect")
                    {
                        msg = JsonUtility.FromJson<SignalingMessage>(content);
                        Dispatch(() => OnCreateConnection?.Invoke(this, msg.connectionId, msg.polite), sender);
                    }
                    else if (routedMessage.type == "disconnect")
                    {
                        msg = JsonUtility.FromJson<SignalingMessage>(content);
                        Dispatch(() => OnDestroyConnection?.Invoke(this, msg.connectionId), sender);
                    }
                    else if (routedMessage.type == "offer")
                    {
                        DescData offer = new DescData();
                        offer.connectionId = routedMessage.from;
                        offer.sdp = msg.sdp;
                        offer.polite = msg.polite;
                        Dispatch(() => OnOffer?.Invoke(this, offer), sender);
                    }
                    else if (routedMessage.type == "answer")
                    {
                        DescData answer = new DescData
                        {
                            connectionId = routedMessage.from,
                            sdp = msg.sdp
                        };
                        Dispatch(() => OnAnswer?.Invoke(this, answer), sender);
                    }
                    else if (routedMessage.type == "candidate")
                    {
                        CandidateData candidate = new CandidateData
                        {
                            connectionId = routedMessage.@from,
                            candidate = msg.candidate,
                            sdpMLineIndex = msg.sdpMLineIndex,
                            sdpMid = msg.sdpMid
                        };
                        Dispatch(() => OnIceCandidate?.Invoke(this, candidate), sender);
                    }
                    else if (routedMessage.type == "error")
                    {
                        msg = JsonUtility.FromJson<SignalingMessage>(content);
                        RenderStreaming.Logger.Log(LogType.Error, msg.message);
                    }
                }
            }
            catch (Exception ex)
            {
                RenderStreaming.Logger.Log(LogType.Error, "Signaling: Failed to parse message: " + ex);
            }
        }

        private void WSConnected(object sender, EventArgs e)
        {
            if (!m_running || !ReferenceEquals(sender, m_webSocket)) return;
            SetState(SignalingConnectionState.Connected, Volatile.Read(ref m_generation));
            RenderStreaming.Logger.Log("Signaling: WS connected.");
            Dispatch(() => OnStart?.Invoke(this), sender);
        }


        private void WSError(object sender, ErrorEventArgs e)
        {
            if (!ReferenceEquals(sender, m_webSocket)) return;
            RenderStreaming.Logger.Log(LogType.Warning, $"Signaling: WS connection error: {e.Message}");
            m_wsCloseEvent.Set();
        }

        private void WSClosed(object sender, CloseEventArgs e)
        {
            RenderStreaming.Logger.Log($"Signaling: WS connection closed, code: {e.Code}");

            if (ReferenceEquals(sender, m_webSocket)) m_wsCloseEvent.Set();
        }

        private void WSSend(object data)
        {
            var socket = m_webSocket;
            if (socket == null || socket.ReadyState != WebSocketState.Open) return;
            try
            {
                socket.Send(data is string text ? text : JsonUtility.ToJson(data));
            }
            catch (Exception error)
            {
                RenderStreaming.Logger.Log(LogType.Warning, "Signaling send failed: " + error.Message);
                if (ReferenceEquals(socket, m_webSocket)) m_wsCloseEvent.Set();
            }
        }
    }
}
