using System;
using System.IO;

namespace Unity.RenderStreaming.InputSystem
{
    /// <summary>
    /// 
    /// </summary>
    static class MessageSerializer
    {
        private const int HeaderSize = 12;

        // The existing wire format is three little-endian Int32 values followed by the payload.
        private static int ReadInt32(byte[] bytes, int offset) => bytes[offset] | bytes[offset + 1] << 8 |
            bytes[offset + 2] << 16 | bytes[offset + 3] << 24;

        private static void WriteInt32(byte[] bytes, int offset, int value)
        {
            bytes[offset] = (byte)value;
            bytes[offset + 1] = (byte)(value >> 8);
            bytes[offset + 2] = (byte)(value >> 16);
            bytes[offset + 3] = (byte)(value >> 24);
        }
        /// <summary>
        /// 
        /// </summary>
        /// <param name="message"></param>
        /// <returns></returns>
        public static byte[] Serialize(ref InputRemoting.Message message)
        {
            if (message.data == null) throw new ArgumentNullException(nameof(message.data));
            var bytes = new byte[checked(HeaderSize + message.data.Length)];
            WriteInt32(bytes, 0, message.participantId);
            WriteInt32(bytes, 4, (int)message.type);
            WriteInt32(bytes, 8, message.data.Length);
            Buffer.BlockCopy(message.data, 0, bytes, HeaderSize, message.data.Length);
            return bytes;
        }

        /// <summary>
        /// 
        /// </summary>
        /// <param name="bytes"></param>
        /// <param name="message"></param>
        public static void Deserialize(byte[] bytes, out InputRemoting.Message message)
        {
            if (!TryDeserialize(bytes, out message)) throw new InvalidDataException("Invalid Render Streaming input message framing.");
        }

        /// <summary>Reject unrelated channel messages before allocating or interpreting their payload.</summary>
        public static bool TryDeserialize(byte[] bytes, out InputRemoting.Message message)
        {
            message = default;
            if (bytes == null || bytes.Length < HeaderSize) return false;
            int type = ReadInt32(bytes, 4), length = ReadInt32(bytes, 8);
            if (type < (int)InputRemoting.MessageType.Connect || type > (int)InputRemoting.MessageType.StopSending ||
                length < 0 || length != bytes.Length - HeaderSize) return false;
            var data = length == 0 ? Array.Empty<byte>() : new byte[length];
            if (length > 0) Buffer.BlockCopy(bytes, HeaderSize, data, 0, length);
            message = new InputRemoting.Message { participantId = ReadInt32(bytes, 0), type = (InputRemoting.MessageType)type, data = data };
            return true;
        }
    }
}
// #endif
