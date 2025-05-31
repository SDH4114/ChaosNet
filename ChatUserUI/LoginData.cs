using System.Collections.Generic;

namespace ChatUserUI.Auth;

public class User
{
    public string Nick { get; set; } = string.Empty; // Initialize properties
    public string ID { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
}

public static class LoginData
{
    public static List<User> Users = new List<User>
    {
        new User { Nick = "SDHaos", ID = "SH4114", Password = "DH44752187" },
        new User { Nick = "GodOfLies", ID = "CL7770", Password = "DH44752187" },
        new User { Nick = "Billvechen", ID = "FB3541", Password = "Bifarkanon100" },
        new User { Nick = "Fern", ID = "FN3525", Password = "D1p7L0q2" }
    };
}