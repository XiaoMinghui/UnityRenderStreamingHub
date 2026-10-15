using System.Collections;
using System.IO;
using NUnit.Framework;
using Unity.RenderStreaming.InputSystem;
using Unity.RenderStreaming.RuntimeTest.Signaling;
using Unity.WebRTC;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.TestTools;
using Assert = NUnit.Framework.Assert;

namespace Unity.RenderStreaming.RuntimeTest
{
    using InputRemoting = InputSystem.InputRemoting;

    class MessageSerializerTest
    {
        [Test]
        public void TruncatedPayloadIsRejectedBeforeAllocating()
        {
            // Keep the pre-fix reproducer bounded: 13 actual bytes must not allocate the declared 1 MiB.
            var bytes = new byte[13];
            System.Buffer.BlockCopy(System.BitConverter.GetBytes((int)InputRemoting.MessageType.NewEvents), 0, bytes, 4, 4);
            System.Buffer.BlockCopy(System.BitConverter.GetBytes(1024 * 1024), 0, bytes, 8, 4);
            Assert.Throws<InvalidDataException>(() => MessageSerializer.Deserialize(bytes, out _));
        }

        [Test]
        public void AllocationOfTruncatedPacketIsBounded()
        {
            var method = typeof(System.GC).GetMethod("GetAllocatedBytesForCurrentThread", System.Type.EmptyTypes);
            if (method == null) Assert.Ignore("Allocation counter is not available on this runtime.");
            var allocated = (System.Func<long>)System.Delegate.CreateDelegate(typeof(System.Func<long>), method);
            long calibrationStart = allocated();
            var calibration = new byte[4096];
            long calibrationBytes = allocated() - calibrationStart;
            System.GC.KeepAlive(calibration);
            if (calibrationBytes < 4096) Assert.Ignore("Allocation counter is inactive in this Unity runtime; use the standalone Mono allocation probe.");
            var bytes = new byte[13];
            System.Buffer.BlockCopy(System.BitConverter.GetBytes((int)InputRemoting.MessageType.NewEvents), 0, bytes, 4, 4);
            System.Buffer.BlockCopy(System.BitConverter.GetBytes(1024 * 1024), 0, bytes, 8, 4);
            // Warm up the code before measuring; the old code allocates 1 MiB for each tiny packet.
            try { MessageSerializer.Deserialize(bytes, out _); } catch (InvalidDataException) { }
            long before = allocated();
            for (int i = 0; i < 32; ++i)
                try { MessageSerializer.Deserialize(bytes, out _); } catch (InvalidDataException) { }
            long delta = allocated() - before;
            UnityEngine.Debug.Log($"Input message allocation: 32 x 13-byte truncated packets allocated {delta} bytes.");
            Assert.Less(delta, 256 * 1024, "Malformed packets must not allocate their untrusted declared length.");
        }

        [Test]
        public void RejectsCustomTextAndMalformedHeadersWithoutPayloadAllocation()
        {
            Assert.IsFalse(MessageSerializer.TryDeserialize(null, out _));
            Assert.IsFalse(MessageSerializer.TryDeserialize(new byte[11], out _));
            Assert.IsFalse(MessageSerializer.TryDeserialize(System.Text.Encoding.UTF8.GetBytes("msg to unity"), out _));
            Assert.IsFalse(MessageSerializer.TryDeserialize(System.Text.Encoding.UTF8.GetBytes("{\"MessageType\":\"Screen\",\"Width\":1280}"), out _));
            foreach (int length in new[] { -1, 1, 1024 * 1024, int.MaxValue })
            {
                var bytes = new byte[12];
                System.Buffer.BlockCopy(System.BitConverter.GetBytes(length), 0, bytes, 8, 4);
                Assert.IsFalse(MessageSerializer.TryDeserialize(bytes, out var message));
                Assert.IsNull(message.data);
            }
            var unknownType = new byte[12];
            System.Buffer.BlockCopy(System.BitConverter.GetBytes(100), 0, unknownType, 4, 4);
            Assert.IsFalse(MessageSerializer.TryDeserialize(unknownType, out _));
            // Extra bytes are malformed too: one DataChannel message contains exactly one input frame.
            Assert.IsFalse(MessageSerializer.TryDeserialize(new byte[13], out _));
        }

        [Test]
        public void WireFormatRemainsLittleEndianAndAcceptsEmptyControlMessages()
        {
            var message = new InputRemoting.Message { participantId = 0x12345678,
                type = InputRemoting.MessageType.NewEvents, data = new byte[] { 5, 6 } };
            CollectionAssert.AreEqual(new byte[] { 0x78, 0x56, 0x34, 0x12, 4, 0, 0, 0, 2, 0, 0, 0, 5, 6 }, MessageSerializer.Serialize(ref message));
            foreach (InputRemoting.MessageType type in System.Enum.GetValues(typeof(InputRemoting.MessageType)))
            {
                message.type = type; message.data = System.Array.Empty<byte>();
                Assert.IsTrue(MessageSerializer.TryDeserialize(MessageSerializer.Serialize(ref message), out var roundtrip));
                Assert.AreEqual(type, roundtrip.type); Assert.IsEmpty(roundtrip.data);
            }
        }

        [Test]
        public void Serialize()
        {
            InputRemoting.Message message1 = new InputRemoting.Message
            {
                participantId = 1,
                type = InputRemoting.MessageType.NewEvents,
                data = new byte[] { 1, 2, 3, 4, 5 },
            };

            var bytes = MessageSerializer.Serialize(ref message1);

            Assert.That(bytes, Is.Not.Null);
            Assert.That(bytes, Has.Length.GreaterThan(0));

            MessageSerializer.Deserialize(bytes, out var message2);
            Assert.That(message2.participantId, Is.EqualTo(message1.participantId));
            Assert.That(message2.type, Is.EqualTo(message1.type));
            Assert.That(message2.data, Is.EqualTo(message1.data));
        }
    }

    /// todo(kazuki):workaround
    class InputRemotingTest
    {
        class MyMonoBehaviourTest : MonoBehaviour, IMonoBehaviourTest
        {
            public bool IsTestFinished
            {
                get { return true; }
            }
        }

        private MonoBehaviourTest<MyMonoBehaviourTest> _test;
        private SignalingManagerInternal _target1, _target2;
        private RTCDataChannel _channel1, _channel2;
        private InputDevice _testDevice;
        private string connectionId = "12345";
        const float ResendOfferInterval = 3f;

        private RenderStreamingDependencies CreateDependencies()
        {
            return new RenderStreamingDependencies
            {
                signaling = new MockSignaling(),
                config = new RTCConfiguration
                {
                    iceServers = new[] { new RTCIceServer { urls = new[] { "stun:stun.l.google.com:19302" } } },
                },
                startCoroutine = _test.component.StartCoroutine,
                stopCoroutine = _test.component.StopCoroutine,
                resentOfferInterval = ResendOfferInterval,
            };
        }

        [UnitySetUp]
        public IEnumerator UnitySetUp()
        {
            MockSignaling.Reset(true);
            // Batch-mode editors have no physical devices. Supply a deterministic local input source.
            _testDevice = UnityEngine.InputSystem.InputSystem.AddDevice<Keyboard>();
            _test = new MonoBehaviourTest<MyMonoBehaviourTest>();

            var dependencies1 = CreateDependencies();
            var dependencies2 = CreateDependencies();
            _target1 = new SignalingManagerInternal(ref dependencies1);
            _target2 = new SignalingManagerInternal(ref dependencies2);

            bool isStarted1 = false;
            bool isStarted2 = false;
            _target1.onStart += () => { isStarted1 = true; };
            _target2.onStart += () => { isStarted2 = true; };
            yield return new WaitUntil(() => isStarted1 && isStarted2);

            bool isCreatedConnection1 = false;
            bool isCreatedConnection2 = false;
            _target1.onCreatedConnection += _ => { isCreatedConnection1 = true; };
            _target2.onCreatedConnection += _ => { isCreatedConnection2 = true; };

            // _target1 is Receiver in private mode
            _target1.CreateConnection(connectionId);
            yield return new WaitUntil(() => isCreatedConnection1);

            // _target2 is sender in private mode
            _target2.CreateConnection(connectionId);
            yield return new WaitUntil(() => isCreatedConnection2);

            _target1.onAddChannel += (_, channel) => { _channel1 = channel; };

            // send offer automatically after creating channel
            _channel2 = _target2.CreateChannel(connectionId, "_test");

            bool isGotOffer1 = false;
            bool isGotAnswer2 = false;
            _target1.onGotOffer += (_, sdp) => { isGotOffer1 = true; };
            _target2.onGotAnswer += (_, sdp) => { isGotAnswer2 = true; };

            // each peer are not stable, signaling process not complete.
            yield return new WaitUntil(() => isGotOffer1);

            _target1.SendAnswer(connectionId);
            yield return new WaitUntil(() => isGotAnswer2);
            Assert.That(isGotAnswer2, Is.True);

            // If target1 processes resent　Offer from target2, target1 is not stable.
            Assert.That(_target2.IsStable(connectionId), Is.True);

            yield return new WaitUntil(() => _channel1 != null);
            Assert.That(_channel1.ReadyState, Is.EqualTo(RTCDataChannelState.Open));
        }

        [UnityTearDown]
        public IEnumerator UnityTearDown()
        {
            _target1.DeleteConnection(connectionId);
            _target2.DeleteConnection(connectionId);

            bool isDeletedConnection1 = false;
            bool isDeletedConnection2 = false;
            _target1.onDeletedConnection += _ => { isDeletedConnection1 = true; };
            _target2.onDeletedConnection += _ => { isDeletedConnection2 = true; };
            yield return new WaitUntil(() => isDeletedConnection1 && isDeletedConnection2);

            _channel1.Dispose();
            _channel2.Dispose();
            _channel1 = null;
            _channel2 = null;
            _test.component.StopAllCoroutines();
            _target1.Dispose();
            _target2.Dispose();
            UnityEngine.Object.DestroyImmediate(_test.gameObject);
            if (_testDevice != null) UnityEngine.InputSystem.InputSystem.RemoveDevice(_testDevice);
            _testDevice = null;
        }

        [Test]
        public void DoNothing()
        {
        }

        [Test]
        public void CustomMessagesReachApplicationCallbacksAndDisposedReceiverDetaches()
        {
            var receiver = new Receiver(_channel1);
            int inputMessages = 0, applicationMessages = 0;
            receiver.onMessage += _ => inputMessages++;
            DelegateOnMessage application = _ => applicationMessages++;
            _channel1.OnMessage += application;
            try
            {
                Assert.DoesNotThrow(() => _channel1.OnMessage(System.Text.Encoding.UTF8.GetBytes("msg to unity")));
                Assert.DoesNotThrow(() => _channel1.OnMessage(System.Text.Encoding.UTF8.GetBytes("{\"MessageType\":\"Screen\",\"Width\":1280}")));
                Assert.AreEqual(0, inputMessages);
                Assert.AreEqual(2, applicationMessages);
                var message = new InputRemoting.Message { type = InputRemoting.MessageType.StopSending, data = System.Array.Empty<byte>() };
                var bytes = MessageSerializer.Serialize(ref message);
                _channel1.OnMessage(bytes);
                Assert.AreEqual(1, inputMessages);
                receiver.Dispose(); receiver.Dispose();
                Assert.IsFalse(System.Array.Exists(_channel1.OnMessage.GetInvocationList(), d => ReferenceEquals(d.Target, receiver)));
                _channel1.OnMessage(bytes);
                Assert.AreEqual(1, inputMessages, "Disposed input receivers must not handle subsequent messages.");
                Assert.AreEqual(4, applicationMessages, "Disposal must preserve application-owned channel handlers.");
            }
            finally { receiver.Dispose(); _channel1.OnMessage -= application; }
        }

        [UnityTest, Timeout(5000)]
        public IEnumerator TextJsonAndInputFramesShareARealChannel()
        {
            var receiver = new Receiver(_channel1);
            int inputMessages = 0, applicationMessages = 0;
            receiver.onMessage += _ => inputMessages++;
            DelegateOnMessage application = _ => applicationMessages++;
            _channel1.OnMessage += application;
            try
            {
                var message = new InputRemoting.Message { type = InputRemoting.MessageType.StopSending, data = System.Array.Empty<byte>() };
                var input = MessageSerializer.Serialize(ref message);
                for (int i = 0; i < 32; i++)
                {
                    _channel2.Send("msg to unity");
                    _channel2.Send("{\"MessageType\":\"Screen\",\"Width\":1280}");
                    _channel2.Send(input);
                }
                yield return new WaitUntil(() => applicationMessages == 96);
                Assert.AreEqual(32, inputMessages, "Only input-framed messages should reach InputRemoting.");
                Assert.AreEqual(RTCDataChannelState.Open, _channel1.ReadyState);
            }
            finally { receiver.Dispose(); _channel1.OnMessage -= application; }
        }

        [TestCase(false), TestCase(true)]
        public void ReplacingInputChannelDoesNotAccumulateReceivers(bool automatic)
        {
            var go = new GameObject("Input receiver lifecycle test");
            go.SetActive(false);
            InputChannelReceiverBase component = null;
            InputActionAsset asset = null;
            try
            {
                if (automatic)
                    component = (InputChannelReceiverBase)go.AddComponent(typeof(AutomaticStreaming).GetNestedType("AutoInputReceiver", System.Reflection.BindingFlags.NonPublic));
                else
                {
                    var receiver = go.AddComponent<InputReceiver>();
                    asset = ScriptableObject.CreateInstance<InputActionAsset>();
                    asset.AddActionMap("test"); receiver.actions = asset; component = receiver;
                }
                go.SetActive(true);
                component.SetChannel("first", _channel1);
                int count = _channel1.OnMessage.GetInvocationList().Length;
                for (int i = 0; i < 32; i++) component.SetChannel("first", _channel1);
                Assert.AreEqual(count, _channel1.OnMessage.GetInvocationList().Length, "Reassigning the same channel must be idempotent.");
                for (int i = 0; i < 16; i++)
                {
                    component.SetChannel("second", _channel2);
                    Assert.IsNull(_channel1.OnMessage, "Previous channel handlers must be detached.");
                    component.SetChannel("first", _channel1);
                    Assert.IsNull(_channel2.OnMessage);
                    Assert.AreEqual(count, _channel1.OnMessage.GetInvocationList().Length);
                }
                UnityEngine.Object.DestroyImmediate(go);
                Assert.IsNull(_channel1.OnMessage, "Destroying the component must detach its channel callbacks.");
            }
            finally
            {
                if (go != null) UnityEngine.Object.DestroyImmediate(go);
                if (asset != null) UnityEngine.Object.DestroyImmediate(asset);
            }
        }


        [Test]
        public void Sender()
        {
            var sender = new Sender();
            Assert.That(sender.layouts, Is.Not.Empty);
            Assert.That(sender.devices, Is.Not.Empty);
            Assert.That(sender.GetDeviceById(0), Is.Null);
            var senderInput = new InputRemoting(sender);
            var senderDisposer = senderInput.Subscribe(new Observer(_channel1));
            senderInput.StartSending();
            senderInput.StopSending();
            senderDisposer.Dispose();
            sender.Dispose();
            sender.Dispose();
        }

        [Test]
        public void Receiver()
        {
            var receiver = new Receiver(_channel1);
            Assert.That(receiver.remoteDevices, Is.Empty);
            Assert.That(receiver.remoteLayouts, Is.Empty);
            Assert.That(receiver.GetDeviceById(0), Is.Null);
            var receiverInput = new InputRemoting(receiver);
            var receiverDisposer = receiverInput.Subscribe(receiverInput);
            receiverInput.StartSending();
            receiverInput.StopSending();
            receiverDisposer.Dispose();
            receiver.Dispose();
        }

        /// todo(kazuki): This test is failed for timeout on macOS.
        /// todo(kazuki): This test is failed for timeout on iPhonePlayer.
        [UnityTest, Timeout(3000)]
        [UnityPlatform(exclude = new[] { RuntimePlatform.OSXPlayer, RuntimePlatform.IPhonePlayer })]
        public IEnumerator AddDevice()
        {
            var sender = new Sender();
            var senderInput = new InputRemoting(sender);
            var senderSubscriberDisposer = senderInput.Subscribe(new Observer(_channel1));

            var receiver = new Receiver(_channel2);
            var receiverInput = new InputRemoting(receiver);
            var receiverSubscriberDisposer = receiverInput.Subscribe(receiverInput);

            InputDevice device = null;
            InputDeviceChange change = default;
            receiver.onDeviceChange += (_device, _change) =>
            {
                device = _device;
                change = _change;
            };
            string layoutName = null;
            InputControlLayoutChange layoutChange = default;
            receiver.onLayoutChange += (_name, _change) =>
            {
                layoutName = _name;
                layoutChange = _change;
            };

            receiverInput.StartSending();
            senderInput.StartSending();

            yield return new WaitUntil(() => device != null);
            yield return new WaitUntil(() => layoutName != null);

            Assert.That(device, Is.Not.Null);
            Assert.That(change, Is.EqualTo(InputDeviceChange.Added));
            Assert.That(layoutName, Is.Not.Null);
            Assert.That(layoutChange, Is.EqualTo(InputControlLayoutChange.Added));

            Assert.That(receiver.remoteLayouts, Is.Not.Empty);
            Assert.That(receiver.remoteDevices, Is.Not.Empty);
            Assert.That(receiver.remoteDevices, Has.All.Matches<InputDevice>(d => d.remote));

            senderInput.StopSending();
            receiverInput.StopSending();

            senderSubscriberDisposer.Dispose();
            receiverSubscriberDisposer.Dispose();
            sender.Dispose();
            receiver.Dispose();
        }

        [Test]
        public void RemoveRemoteDevices()
        {
            var sender = new Sender();
            var senderInput = new InputRemoting(sender);
            senderInput.RemoveRemoteDevices(0);
            sender.Dispose();
        }

        [Test]
        public void SaveState()
        {
            var sender = new Sender();
            var inputRemoting = new InputRemoting(sender);
            var state = inputRemoting.SaveState();
            inputRemoting.RestoreState(state, sender);
            sender.Dispose();
        }
    }
}
