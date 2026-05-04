using Folio.Services;

if (args.Length < 1)
{
    Console.Error.WriteLine("Usage: GoldfileGen <path-to-md-file>");
    Environment.Exit(1);
}

var path = args[0];
var renderer = new MarkdownRenderer();
var html = renderer.RenderFile(path);
Console.WriteLine(html);
