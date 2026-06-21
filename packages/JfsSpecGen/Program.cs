using System.Text.Json;
using JfsSpecGen;

var outPath = "";
for (int i = 0; i < args.Length - 1; i++)
    if (args[i] == "--out") outPath = args[i + 1];

var doc = JfsSpec.Build();
var options = new JsonSerializerOptions { WriteIndented = true };
var json = JsonSerializer.Serialize(doc, options);

if (!string.IsNullOrEmpty(outPath))
{
    var dir = Path.GetDirectoryName(outPath);
    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
    File.WriteAllText(outPath, json);
    Console.Error.WriteLine($"[JfsSpecGen] Written to {outPath}");
}
else
    Console.Write(json);
