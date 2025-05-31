using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.Threading;
using Avalonia.Media.Immutable;
using Avalonia.Layout;
using System;
using System.IO;
using System.Net.Sockets;
using System.Threading.Tasks;

namespace ChatUserUI;

public partial class MainWindow : Window
{
    private TcpClient? client;
    private StreamWriter? writer;
    private StreamReader? reader;
    private string userName = "";
    private bool connected = false;

    public MainWindow()
    {
        InitializeComponent();
        AddMessage("💡 Чат загружен. Введите имя и нажмите Enter", "system");
    }

    private async void Connect(string name)
    {
        try
        {
            AddMessage("🔌 Подключение к серверу...", "system");

            client = new TcpClient("127.0.0.1", 5050);
            var stream = client.GetStream();
            reader = new StreamReader(stream);
            writer = new StreamWriter(stream) { AutoFlush = true };

            string? prompt = await reader.ReadLineAsync();
            if (!string.IsNullOrWhiteSpace(prompt))
                AddMessage(prompt, "system");

            await writer.WriteLineAsync(name);

            while (true)
            {
                string? response = await reader.ReadLineAsync();
                if (response == null) break;

                AddMessage("📩 От сервера: " + response, "system");

                if (response.StartsWith("Имя занято"))
                {
                    AddMessage(response, "error");
                    return;
                }
                else if (response.StartsWith("Вы подключились"))
                {
                    AddMessage(response, "system");
                    connected = true;
                    break;
                }
            }

            _ = Task.Run(ReceiveMessages);
        }
        catch (Exception ex)
        {
            AddMessage("❌ Ошибка подключения: " + ex.Message, "error");
        }
    }

    private async void Send_Click(object? sender, RoutedEventArgs e)
    {
        string message = MessageBox.Text?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(message)) return;

        if (!connected)
        {
            userName = message;
            MessageBox.Text = "";
            AddMessage($"Вы: {userName}", "self");
            Connect(userName);
            return;
        }

        string fullMessage = $"{userName}: {message}";
        await writer!.WriteLineAsync(fullMessage);
        AddMessage(fullMessage, "self");
        MessageBox.Text = "";
    }

    private async Task ReceiveMessages()
    {
        try
        {
            AddMessage("🔄 Ожидание сообщений...", "system");

            while (reader != null && !reader.EndOfStream)
            {
                string? msg = await reader.ReadLineAsync();
                if (msg == null)
                {
                    AddMessage("❗ Получено пустое сообщение", "error");
                    break;
                }

                if (msg.StartsWith("[Server]:"))
                {
                    AddMessage(msg, "system");
                }
                else if (msg.StartsWith("[Admin]:"))
                {
                    AddMessage(msg, "admin");
                }
                else if (msg.StartsWith($"{userName}:"))
                {
                    // Не отображаем повторно свои сообщения
                }
                else
                {
                    // 🎯 Получить имя отправителя
                    var parts = msg.Split(':', 2);
                    if (parts.Length == 2)
                    {
                        var sender = parts[0].Trim();
                        AddMessage($"💬 {sender} отправил сообщение", "system"); // по центру
                    }

                    AddMessage(msg, "user"); // сообщение от другого
                }
            }
        }
        catch (Exception ex)
        {
            AddMessage("❌ Ошибка при получении: " + ex.Message, "error");
        }
    }
    private void AddMessage(string text, string type)
    {
        var foreground = Brushes.White.ToImmutable();
        var background = Brushes.Transparent.ToImmutable();
        var align = HorizontalAlignment.Left;

        switch (type)
        {
            case "system":
                background = new SolidColorBrush(Color.FromRgb(60, 60, 60)).ToImmutable();
                align = HorizontalAlignment.Center;
                break;
            case "error":
                background = Brushes.DarkRed.ToImmutable();
                align = HorizontalAlignment.Center;
                break;
            case "admin":
                background = Brushes.Purple.ToImmutable();
                break;
            case "self":
                background = new SolidColorBrush(Color.FromRgb(33, 150, 243)).ToImmutable(); // синий
                align = HorizontalAlignment.Right;
                break;
            case "user":
                background = new SolidColorBrush(Color.FromRgb(76, 175, 80)).ToImmutable(); // зелёный
                align = HorizontalAlignment.Left;
                break;
        }

        var stack = new StackPanel
        {
            Orientation = Orientation.Vertical
        };

        string message = text;

        // ✏️ Обработка отображаемого текста
        if (type == "self")
        {
            if (text.StartsWith(userName + ":"))
                message = text.Substring(userName.Length + 1).Trim(); // убираем "SDHaos:"
        }
        else if (type == "user")
        {
            // text = "Fern: hello"
            // Оставляем как есть, показываем с именем
        }

        var messageBlock = new TextBlock
        {
            Text = message,
            FontSize = 15,
            TextWrapping = TextWrapping.Wrap,
            Foreground = foreground
        };

        var timeBlock = new TextBlock
        {
            Text = DateTime.Now.ToString("HH:mm"),
            FontSize = 12,
            Foreground = Brushes.White.ToImmutable(),
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 4, 0, 0)
        };

        stack.Children.Add(messageBlock);
        stack.Children.Add(timeBlock);

        var border = new Border
        {
            Background = background,
            CornerRadius = new CornerRadius(12),
            Padding = new Thickness(12, 6),
            Margin = new Thickness(5),
            Child = stack,
            HorizontalAlignment = align,
            MaxWidth = 400
        };

        Dispatcher.UIThread.Post(() =>
        {
            ChatPanel.Children.Add(border);

            if (ChatPanel.Parent is ScrollViewer scroll)
                scroll.Offset = new Vector(0, scroll.Extent.Height);
        });
    } 
    private void MessageBox_KeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            Send_Click(sender, new RoutedEventArgs());
            e.Handled = true;
        }
    }
}