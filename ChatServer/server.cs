using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
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
        Console.WriteLine("Сервер запущен. Команды: 'exit', 'kick <имя>', обычный текст — всем клиентам.");

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
            using NetworkStream stream = client.GetStream();
            using StreamReader reader = new StreamReader(stream);
            using StreamWriter writer = new StreamWriter(stream) { AutoFlush = true };

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

            Console.WriteLine($"Подключился: {clientName}");
            BroadcastMessage($"[Server]: {clientName} присоединился к чату.");

            string? message;
            while ((message = reader.ReadLine()) != null)
            {
                BroadcastMessage($"{clientName}: {message}", exclude: client);
                Console.WriteLine($"{clientName}: {message}");
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
                Console.WriteLine($"Отключён: {clientName}");
            }

            client.Close();
        }
    }

    static void BroadcastMessage(string message, TcpClient? exclude = null)
    {
        lock (clientLock)
        {
            foreach (var kv in clients)
            {
                TcpClient client = kv.Value;
                if (client == exclude || !client.Connected) continue;

                try
                {
                    StreamWriter writer = new StreamWriter(client.GetStream()) { AutoFlush = true };
                    writer.WriteLine(message);
                }
                catch { }
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
                    StreamWriter writer = new StreamWriter(client.GetStream()) { AutoFlush = true };
                    writer.WriteLine("Вы были отключены сервером.");
                }
                catch { }

                client.Close();
                clients.Remove(name);
                BroadcastMessage($"[Server]: {name} был удалён с сервера.");
                Console.WriteLine($"Клиент {name} отключён.");
            }
            else
            {
                Console.WriteLine($"Клиент с именем {name} не найден.");
            }
        }
    }

    static void StopServer()
    {
        Console.WriteLine("Остановка сервера...");
        cts.Cancel();
        listener?.Stop();

        lock (clientLock)
        {
            foreach (var client in clients.Values)
            {
                try { client.Close(); } catch { }
            }
            clients.Clear();
        }

        Console.WriteLine("Сервер остановлен.");
    }
}