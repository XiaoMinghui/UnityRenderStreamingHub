using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Threading;
using NUnit.Framework;
using Unity.RenderStreaming.Signaling;
using Unity.WebRTC;
using UnityEngine;
using UnityEngine.TestTools;
using WebSocketSharp;

namespace Unity.RenderStreaming.RuntimeTest
{
    public class PoolSenderSignalingTest
    {
        [Serializable] private class Payload { public string sdp, connectionId; }
        [Serializable] private class Message { public string type, connectionId, leaseId; public Payload data; }
        private Process server;
        private PoolSenderSignaling sender;
        private WebSocket receiver, waiting;

        [UnityTearDown]
        public IEnumerator TearDown()
        {
            sender?.Stop();
            receiver?.CloseAsync();
            waiting?.CloseAsync();
            if (server != null && !server.HasExited) { server.Kill(); server.WaitForExit(5000); }
            server?.Dispose();
            yield return null;
        }

        [UnityTest]
        public IEnumerator RoutesSignalsAndRequiresCurrentResetTicket()
        {
            var webApp = Environment.GetEnvironmentVariable("RENDERSTREAMING_POOL_TEST_WEBAPP");
            if (string.IsNullOrEmpty(webApp)) Assert.Ignore("Set RENDERSTREAMING_POOL_TEST_WEBAPP to the built WebApp source directory.");
            var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
            listener.Start();
            var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            var start = new ProcessStartInfo {
                FileName = Environment.GetEnvironmentVariable("RENDERSTREAMING_POOL_TEST_NODE") ?? "node",
                Arguments = $"\"{Path.Combine(webApp, "build/index.js")}\" -p {port} -t websocket -m public --pool -l none",
                WorkingDirectory = webApp, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            start.EnvironmentVariables["RENDERSTREAMING_POOL_TOKEN"] = "unity-pool-test-token";
            server = Process.Start(start);
            bool started = false;
            server.OutputDataReceived += (_, e) => { if (!string.IsNullOrEmpty(e.Data)) started = true; };
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();
            yield return Until(() => started || server.HasExited);
            Assert.IsFalse(server.HasExited, "Test server failed to start.");

            string reset = null, offer = null;
            int resets = 0, starts = 0;
            var errors = new ConcurrentQueue<string>();
            sender = new PoolSenderSignaling($"ws://127.0.0.1:{port}/pool", "unity-test", "default", "unity-pool-test-token", SynchronizationContext.Current);
            sender.OnStart += _ => starts++;
            sender.ResetRequested += ticket => { reset = ticket; resets++; };
            sender.OnOffer += (_, data) => offer = data.sdp;
            sender.Error += errors.Enqueue;
            sender.Start();
            yield return Until(() => reset != null);
            var initialReset = reset;
            sender.CompleteReset(reset);

            var firstMessages = new ConcurrentQueue<Message>();
            receiver = Connect(port, firstMessages);
            receiver.Send("{\"type\":\"join\",\"connectionId\":\"unity-receiver\",\"poolId\":\"default\"}");
            Message assignment = null;
            yield return Until(() => Find(firstMessages, "assigned", out assignment));
            receiver.Send("{\"type\":\"offer\",\"leaseId\":\"" + assignment.leaseId + "\",\"data\":{\"connectionId\":\"unity-receiver\",\"sdp\":\"test-offer\"}}");
            yield return Until(() => offer != null);
            Assert.AreEqual("test-offer", offer);
            sender.SendAnswer("unity-receiver", new RTCSessionDescription { type = RTCSdpType.Answer, sdp = "test-answer" });
            Message answer = null;
            yield return Until(() => Find(firstMessages, "answer", out answer));
            Assert.AreEqual("test-answer", answer.data.sdp);
            receiver.CloseAsync();
            yield return Until(() => resets == 2);

            var secondMessages = new ConcurrentQueue<Message>();
            waiting = Connect(port, secondMessages);
            waiting.Send("{\"type\":\"join\",\"connectionId\":\"unity-waiting\",\"poolId\":\"default\"}");
            Message queued = null;
            yield return Until(() => Find(secondMessages, "queued", out queued));
            sender.CompleteReset(initialReset);
            yield return new WaitForSecondsRealtime(0.2f);
            Assert.IsFalse(Find(secondMessages, "assigned", out _), "An old reset must not release the sender.");
            sender.CompleteReset(reset);
            yield return Until(() => Find(secondMessages, "assigned", out assignment));
            Assert.AreEqual("unity-waiting", assignment.connectionId);
            var previousReset = reset;
            sender.Stop();
            Message disconnected = null;
            yield return Until(() => Find(secondMessages, "disconnect", out disconnected));
            sender.Start();
            yield return Until(() => starts == 2 && resets == 3);
            sender.CompleteReset(previousReset);
            sender.CompleteReset(reset);
            waiting.Send("{\"type\":\"join\",\"connectionId\":\"unity-restarted\",\"poolId\":\"default\"}");
            yield return Until(() => Find(secondMessages, "assigned", out assignment));
            Assert.AreEqual("unity-restarted", assignment.connectionId);
            Assert.AreEqual(2, starts);
            Assert.IsEmpty(errors);
        }

        private static WebSocket Connect(int port, ConcurrentQueue<Message> messages)
        {
            var socket = new WebSocket($"ws://127.0.0.1:{port}/pool");
            // JsonUtility must run on the Unity main thread, not this socket callback.
            var context = SynchronizationContext.Current;
            socket.OnMessage += (_, e) => { if (e.IsText) context.Post(__ => messages.Enqueue(JsonUtility.FromJson<Message>(e.Data)), null); };
            socket.Connect();
            Assert.AreEqual(WebSocketState.Open, socket.ReadyState);
            return socket;
        }

        private static bool Find(ConcurrentQueue<Message> messages, string type, out Message found)
        {
            found = null;
            while (messages.TryDequeue(out var message)) if (message.type == type) { found = message; return true; }
            return false;
        }

        private static IEnumerator Until(Func<bool> condition)
        {
            var deadline = Time.realtimeSinceStartup + 15;
            while (!condition()) {
                Assert.Less(Time.realtimeSinceStartup, deadline, "Timed out waiting for pool signaling.");
                yield return null;
            }
        }
    }
}
