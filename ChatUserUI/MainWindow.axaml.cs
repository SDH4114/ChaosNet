using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.Threading;
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
    private bool nameEntered = false;

    public MainWindow()
    {
        InitializeComponent();
        AddMessage("Введите имя и нажмите Enter", "system");
    }

    private async void Connect(string name)
    {
        try
        {
            client = new TcpClient("127.0.0.1", 5050);
            var stream = client.GetStream();
            reader = new StreamReader(stream);
            writer = new StreamWriter(stream) { AutoFlush = true };

            string? prompt = await reader.ReadLineAsync(); // Введите имя:
            if (!string.IsNullOrWhiteSpace(prompt))
                AddMessage(prompt, "system");

            await writer.WriteLineAsync(name);

            while (true)
            {
                string? response = await reader.ReadLineAsync();
                if (response == null) break;

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
                else
                {
                    AddMessage(response, "system");
                }
            }

            _ = Task.Run(ReceiveMessages);
        }
        catch (Exception ex)
        {
            AddMessage("Ошибка подключения: " + ex.Message, "error");
        }
    }

    private async void Send_Click(object? sender, RoutedEventArgs e)
    {
        string message = MessageBox.Text?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(message)) return;

        if (!connected)
        {
            userName = message;
            nameEntered = true;
            MessageBox.Text = "";
            AddMessage($"Вы: {userName}", "self");
            Connect(userName);
            return;
        }

        await writer!.WriteLineAsync(message);
        MessageBox.Text = "";
    }

    private async Task ReceiveMessages()
    {
        try
        {
            while (reader != null && !reader.EndOfStream)
            {
                string? msg = await reader.ReadLineAsync();
                if (msg == null) break;

                if (msg.StartsWith("[Server]:"))
                    AddMessage(msg, "system");
                else if (msg.StartsWith("[Admin]:"))
                    AddMessage(msg, "admin");
                else if (msg.StartsWith(userName + ":"))
                    AddMessage(msg, "self");
                else
                    AddMessage(msg, "user");
            }
        }
        catch
        {
            AddMessage("Соединение прервано", "error");
        }
    }

    private void AddMessage(string text, string type)
    {
        var messageBlock = new TextBlock
        {
            Text = text,
            FontSize = 16,
            TextWrapping = TextWrapping.Wrap,
            Foreground = Brushes.Black,
            Background = Brushes.Yellow // видно 100%
        };

        var border = new Border
        {
            Background = Brushes.Lime,
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(10),
            Margin = new Thickness(5),
            Child = messageBlock,
            HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Center,
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
            Send_Click(sender, new RoutedEventArgs()); // ⚠️ исправлено
            e.Handled = true;
        }
    }
}