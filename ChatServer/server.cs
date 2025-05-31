using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

class Server
{
    static TcpListener? listener;
    static CancellationTokenSource cts = new CancellationTokenSource();

    static readonly Dictionary<string, TcpClient> clients = new Dictionary<string, TcpClient>();
    static readonly object clientLock = new object();

    static void Main()
    {
        listener = new TcpListener(IPAddress.Any, 5050);
        listener.Start();

        Task.Run(() => AcceptClientsAsync(cts.Token));

        while (true)
        {
            string? command = Console.ReadLine();
            if (command == null) continue;

            if (command.ToLower() == "exit")
            {
                StopServer();
                break;
            }
            else if (command.StartsWith("kick "))
            {
                string nameToKick = command.Substring(5).Trim();
                KickClient(nameToKick);
            }
            else
            {
                BroadcastMessage($"[Admin]: {command}");
            }
        }
    }

    static async Task AcceptClientsAsync(CancellationToken token)
    {
        try
        {
            while (!token.IsCancellationRequested)
            {
                TcpClient client = await listener!.AcceptTcpClientAsync(token);
                Task.Run(() => HandleClient(client));
            }
        }
        catch (OperationCanceledException) { }
    }

    static void HandleClient(TcpClient client)
    {
        string? clientName = null;

        try
        {
            NetworkStream stream = client.GetStream();
            StreamReader reader = new StreamReader(stream);
            StreamWriter writer = new StreamWriter(stream) { AutoFlush = true };

            writer.WriteLine("Введите имя:");

            clientName = reader.ReadLine()?.Trim();

            if (string.IsNullOrWhiteSpace(clientName))
            {
                writer.WriteLine("Имя недопустимо.");
                client.Close();
                return;
            }

            lock (clientLock)
            {
                if (clients.ContainsKey(clientName))
                {
                    writer.WriteLine("Имя занято.");
                    client.Close();
                    return;
                }

                clients[clientName] = client;
            }

            writer.WriteLine("Вы подключились к чату!");
            Console.WriteLine($"✅ Подключился: {clientName}");
            BroadcastMessage($"[Server]: {clientName} присоединился к чату.");

            string? message;
            while ((message = reader.ReadLine()) != null)
            {
                Console.WriteLine($"{message}"); // 👈 вывод в консоль
                BroadcastMessage($"{message}", exclude: client);
            }
        }
        catch { }
        finally
        {
            if (clientName != null)
            {
                lock (clientLock)
                {
                    clients.Remove(clientName);
                }
                BroadcastMessage($"[Server]: {clientName} отключён.");
                Console.WriteLine($"❌ Отключён: {clientName}");
            }

            client.Close();
        }
    }
    static void BroadcastMessage(string message, TcpClient? exclude = null)
    {
        byte[] data = Encoding.UTF8.GetBytes(message + Environment.NewLine); // 👈 исправлено

        lock (clientLock)
        {
            foreach (var kv in clients)
            {
                TcpClient client = kv.Value;
                if (client == exclude || !client.Connected) continue;

                try
                {
                    NetworkStream stream = client.GetStream();
                    if (stream.CanWrite)
                    {
                        stream.Write(data, 0, data.Length);
                    }
                }
                catch
                {
                    // игнорируем ошибки
                }
            }
        }
    }
    static void KickClient(string name)
    {
        lock (clientLock)
        {
            if (clients.TryGetValue(name, out TcpClient? client))
            {
                try
                {
                    var stream = client.GetStream();
                    if (stream.CanWrite)
                    {
                        byte[] msg = Encoding.UTF8.GetBytes("Вы были отключены сервером.\n");
                        stream.Write(msg, 0, msg.Length);
                    }
                }
                catch { }

                client.Close();
                clients.Remove(name);
                BroadcastMessage($"[Server]: {name} был удалён с сервера.");
            }
        }
    }

    static void StopServer()
    {
        cts.Cancel();
        listener?.Stop();

        lock (clientLock)
        {
            foreach (var kvp in clients)
            {
                TcpClient client = kvp.Value;
                try
                {
                    NetworkStream stream = client.GetStream();
                    if (stream.CanWrite)
                    {
                        byte[] msg = Encoding.UTF8.GetBytes("Сервер выключается. Вы были отключены.\n");
                        stream.Write(msg, 0, msg.Length);
                    }
                }
                catch { }

                try { client.Close(); } catch { }
            }

            clients.Clear();
        }
    }
}