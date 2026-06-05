using System.Reflection;
using System.Text.Json.Serialization;

namespace JfsSpecGen;

static class SchemaReflector
{
    static readonly NullabilityInfoContext _ctx = new();

    public static Dictionary<string, object> ReflectType(Type t)
    {
        var props = new Dictionary<string, object>();
        var required = new List<string>();

        foreach (var prop in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var attr = prop.GetCustomAttribute<JsonPropertyNameAttribute>();
            if (attr == null) continue;

            var name = attr.Name;
            var nullInfo = _ctx.Create(prop);
            var nullable = IsNullable(prop.PropertyType, nullInfo);

            props[name] = PropSchema(prop.PropertyType, nullable);
            if (!nullable) required.Add(name);
        }

        var schema = new Dictionary<string, object> { ["type"] = "object", ["properties"] = props };
        if (required.Count > 0) schema["required"] = required;
        return schema;
    }

    static bool IsNullable(Type t, NullabilityInfo info) =>
        Nullable.GetUnderlyingType(t) != null || info.ReadState == NullabilityState.Nullable;

    public static Dictionary<string, object> PropSchema(Type t, bool nullable)
    {
        var s = CoreSchema(t);
        if (!nullable) return s;

        // OAI 3.1 nullable: $ref types use anyOf, scalar types use type array
        if (s.ContainsKey("$ref"))
            return new() { ["anyOf"] = new object[] { s, new Dictionary<string, object> { ["type"] = "null" } } };

        if (s.TryGetValue("type", out var tv) && tv is string ts)
            s["type"] = new[] { ts, "null" };

        return s;
    }

    public static Dictionary<string, object> CoreSchema(Type t)
    {
        var under = Nullable.GetUnderlyingType(t);
        if (under != null) t = under;

        if (t == typeof(string))   return new() { ["type"] = "string" };
        if (t == typeof(bool))     return new() { ["type"] = "boolean" };
        if (t == typeof(int) || t == typeof(short) || t == typeof(byte))
                                   return new() { ["type"] = "integer", ["format"] = "int32" };
        if (t == typeof(long))     return new() { ["type"] = "integer", ["format"] = "int64" };
        if (t == typeof(float))    return new() { ["type"] = "number",  ["format"] = "float" };
        if (t == typeof(double))   return new() { ["type"] = "number",  ["format"] = "double" };
        if (t == typeof(Guid))     return new() { ["type"] = "string",  ["format"] = "uuid" };
        if (t == typeof(DateTime) || t == typeof(DateTimeOffset))
                                   return new() { ["type"] = "string",  ["format"] = "date-time" };

        if (t.IsArray)
            return new() { ["type"] = "array", ["items"] = CoreSchema(t.GetElementType()!) };
        if (t.IsGenericType && t.GetGenericTypeDefinition() == typeof(List<>))
            return new() { ["type"] = "array", ["items"] = CoreSchema(t.GetGenericArguments()[0]) };

        return new() { ["$ref"] = $"#/components/schemas/{t.Name}" };
    }
}
