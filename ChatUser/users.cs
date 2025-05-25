using System;
using System.IO;
using System.Net.Sockets;
using System.Threading.Tasks;

class User
{
    static void Main()
    {
        try
        {
            using TcpClient client = new TcpClient("127.0.0.1", 5050);
            SetColor(ConsoleColor.Green, "Подключено к серверу.");

            using NetworkStream stream = client.GetStream();
            using StreamReader reader = new StreamReader(stream);
            using StreamWriter writer = new StreamWriter(stream) { AutoFlush = true };

            string? name = null;

            while (true)
            {
                string? prompt = reader.ReadLine();
                if (prompt != null)
                    SetColor(ConsoleColor.DarkGray, prompt);

                Console.Write(">> ");
                name = Console.ReadLine()?.Trim();

                if (string.IsNullOrWhiteSpace(name))
                {
                    SetColor(ConsoleColor.Red, "Имя не может быть пустым.");
                    continue;
                }

                writer.WriteLine(name);

                string? response = reader.ReadLine();
                if (response == null) break;

                if (response.StartsWith("Имя занято"))
                {
                    SetColor(ConsoleColor.Red, response);
                    continue;
                }
                else if (response.StartsWith("Вы подключились"))
                {
                    SetColor(ConsoleColor.Green, response);
                    break;
                }
                else
                {
                    Console.WriteLine(response);
                }
            }

            if (name == null) return;

            Task.Run(() =>
            {
                string? msg;
                try
                {
                    while ((msg = reader.ReadLine()) != null)
                        PrintColoredMessage(msg, name);
                }
                catch { }
            });

            string? input;
            while ((input = Console.ReadLine()) != null)
            {
                if (input.ToLower() == "exit")
                    break;

                writer.WriteLine(input);
            }
            Console.Clear();
            SetColor(ConsoleColor.DarkGray, "Вы отключились.");
        }
        catch (Exception ex)
        {
            Console.Clear();
            SetColor(ConsoleColor.Red, "Ошибка: " + ex.Message);
        }
    }

    static void PrintColoredMessage(string msg, string name)
    {
        if (msg.StartsWith("[Admin]:"))
        {
            SetColor(ConsoleColor.Blue, msg);
        }
        else if (msg.StartsWith("[Server]:"))
        {
            if (msg.Contains("kick", StringComparison.OrdinalIgnoreCase) ||
                msg.Contains("удален", StringComparison.OrdinalIgnoreCase) ||
                msg.Contains("отключен", StringComparison.OrdinalIgnoreCase))
            {
                SetColor(ConsoleColor.Red, msg);
            }
            else
            {
                SetColor(ConsoleColor.Green, msg);
            }
        }
        else if (msg.StartsWith(name + ":"))
        {
            SetColor(ConsoleColor.Cyan, msg);
        }
        else
        {
            Console.WriteLine(msg);
        }
    }

    static void SetColor(ConsoleColor color, string message)
    {
        var old = Console.ForegroundColor;
        Console.ForegroundColor = color;
        Console.WriteLine(message);
        Console.ForegroundColor = old;
    }
}