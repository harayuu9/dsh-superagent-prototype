// gh-agent: runs the GitHub CLI with the agent account's own configuration directory (%USERPROFILE%\.config\gh-agent).
// scripts/bootstrap.mjs compiles this with the .NET Framework's csc.exe, which every Windows installation has. A batch
// file cannot be the agent CLI: Node refuses to start .cmd/.bat files through execFile (EINVAL).
// Compiles with the C# 5 compiler of .NET Framework 4: no string interpolation or other newer syntax.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

static class GhAgent
{
    // Quote one argument for CreateProcess the way the Microsoft C runtime parses it back.
    static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
        var sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); }
            else { sb.Append('\\', slashes); sb.Append(c); }
            slashes = 0;
        }
        sb.Append('\\', slashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    // gh.exe on PATH; the worker shim directory holds only gh.cmd, so it is never picked here.
    static string FindGh()
    {
        foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            try
            {
                string file = Path.Combine(dir.Trim().Trim('"'), "gh.exe");
                if (File.Exists(file)) return file;
            }
            catch (ArgumentException) { }
        }
        return @"C:\Program Files\GitHub CLI\gh.exe";
    }

    static int Main(string[] args)
    {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var psi = new ProcessStartInfo(FindGh());
        psi.UseShellExecute = false;
        var quoted = new string[args.Length];
        for (int i = 0; i < args.Length; i++) quoted[i] = Quote(args[i]);
        psi.Arguments = string.Join(" ", quoted);
        psi.EnvironmentVariables["GH_CONFIG_DIR"] = Path.Combine(Path.Combine(home, ".config"), "gh-agent");
        try
        {
            using (var process = Process.Start(psi))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("gh-agent: " + e.Message);
            return 1;
        }
    }
}
