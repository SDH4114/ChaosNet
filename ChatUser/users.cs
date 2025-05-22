using System;
using System.IO;
using System.Net.Sockets;
using System.Threading.Tasks;

class User
{
    static void Main()
    {
        Console.Write("Введите имя: ");
        string name = Console.ReadLine()?.Trim();

        if (string.IsNullOrWhiteSpace(name))
        {
            SetColor(ConsoleColor.Red, "Имя не может быть пустым.");
            return;
        }

        try
        {
            using TcpClient client = new TcpClient("127.0.0.1", 5050);
            SetColor(ConsoleColor.Green, "Подключено к серверу.");

            using NetworkStream stream = client.GetStream();
            using StreamReader reader = new StreamReader(stream);
            using StreamWriter writer = new StreamWriter(stream) { AutoFlush = true };

            // Получаем приглашение ввести имя
            string? prompt = reader.ReadLine();
            if (prompt != null)
                SetColor(ConsoleColor.DarkGray, prompt);

            writer.WriteLine(name);  // отправляем имя

            // Сообщение после авторизации
            string? welcome = reader.ReadLine();
            if (welcome != null)
                SetColor(ConsoleColor.Green, welcome);

            // Приём сообщений
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

            // Отправка сообщений
            string? input;
            while ((input = Console.ReadLine()) != null)
            {
                if (input.ToLower() == "exit")
                    break;

                writer.WriteLine(input);
            }
        }
        catch (Exception ex)
        {
            SetColor(ConsoleColor.Red, "Ошибка: " + ex.Message);
        }

        SetColor(ConsoleColor.DarkGray, "Вы отключились.");
    }

    static void PrintColoredMessage(string msg, string name)
    {
        if (msg.StartsWith("[Admin]:"))
        {
            SetColor(ConsoleColor.Blue, msg);
        }
        else if (msg.StartsWith("[Server]:"))
        {
            // если в тексте есть "kick", "удален", "отключен", выделяем красным
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