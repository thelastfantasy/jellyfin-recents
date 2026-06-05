namespace JfsSpecGen;

class OaDoc
{
    readonly Dictionary<string, object> _schemas = new();
    readonly Dictionary<string, object> _paths = new();

    public OaDoc AddSchema(string name, Dictionary<string, object> schema)
    {
        _schemas[name] = schema;
        return this;
    }

    public OaDoc AddPath(string path, string method, OaOp op)
    {
        if (!_paths.ContainsKey(path))
            _paths[path] = new Dictionary<string, object>();
        ((Dictionary<string, object>)_paths[path])[method] = op.Build();
        return this;
    }

    public Dictionary<string, object> Build() => new()
    {
        ["openapi"] = "3.1.0",
        ["info"] = new Dictionary<string, object>
        {
            ["title"] = "JellyfinSuite Plugin API",
            ["version"] = "1.0.0",
        },
        ["paths"] = _paths,
        ["components"] = new Dictionary<string, object> { ["schemas"] = _schemas },
    };
}

class OaOp
{
    readonly List<object> _params = [];
    readonly Dictionary<string, object> _responses = new();
    string? _tag, _opId, _reqContentType;
    object? _reqSchema;

    public OaOp Tag(string tag)  { _tag = tag;   return this; }
    public OaOp OpId(string id)  { _opId = id;   return this; }

    public OaOp PathParam(string name, string type = "string", string? format = null)
    {
        var schema = new Dictionary<string, object> { ["type"] = type };
        if (format != null) schema["format"] = format;
        _params.Add(new Dictionary<string, object>
        {
            ["name"] = name, ["in"] = "path", ["required"] = true, ["schema"] = schema,
        });
        return this;
    }

    public OaOp QueryParam(string name, string type, bool required = false)
    {
        _params.Add(new Dictionary<string, object>
        {
            ["name"] = name, ["in"] = "query", ["required"] = required,
            ["schema"] = new Dictionary<string, object> { ["type"] = type },
        });
        return this;
    }

    public OaOp QueryParamInt(string name, bool required = false)
    {
        _params.Add(new Dictionary<string, object>
        {
            ["name"] = name, ["in"] = "query", ["required"] = required,
            ["schema"] = new Dictionary<string, object> { ["type"] = "integer", ["format"] = "int64" },
        });
        return this;
    }

    public OaOp QueryParamBool(string name, bool required = false)
    {
        _params.Add(new Dictionary<string, object>
        {
            ["name"] = name, ["in"] = "query", ["required"] = required,
            ["schema"] = new Dictionary<string, object> { ["type"] = "boolean" },
        });
        return this;
    }

    public OaOp Body(string schemaName, string contentType = "application/json")
    {
        _reqContentType = contentType;
        _reqSchema = new Dictionary<string, object> { ["$ref"] = $"#/components/schemas/{schemaName}" };
        return this;
    }

    public OaOp BodyFile()
    {
        _reqContentType = "multipart/form-data";
        _reqSchema = new Dictionary<string, object>
        {
            ["type"] = "object",
            ["properties"] = new Dictionary<string, object>
            {
                ["file"] = new Dictionary<string, object> { ["type"] = "string", ["format"] = "binary" },
            },
        };
        return this;
    }

    public OaOp ResRef(int code, string desc, string schemaName, string contentType = "application/json")
        => Res(code, desc, contentType, new Dictionary<string, object> { ["$ref"] = $"#/components/schemas/{schemaName}" });

    public OaOp ResArray(int code, string desc, string schemaName, string contentType = "application/json")
        => Res(code, desc, contentType, new Dictionary<string, object>
        {
            ["type"] = "array",
            ["items"] = new Dictionary<string, object> { ["$ref"] = $"#/components/schemas/{schemaName}" },
        });

    public OaOp ResBinary(int code, string desc, string contentType = "application/octet-stream")
        => Res(code, desc, contentType, new Dictionary<string, object> { ["type"] = "string", ["format"] = "binary" });

    public OaOp Sse(int code, string schemaName)
        => Res(code, "Server-Sent Events stream", "text/event-stream",
               new Dictionary<string, object> { ["$ref"] = $"#/components/schemas/{schemaName}" });

    public OaOp ResNoContent(int code, string desc)
    {
        _responses[code.ToString()] = new Dictionary<string, object> { ["description"] = desc };
        return this;
    }

    OaOp Res(int code, string desc, string contentType, Dictionary<string, object> schema)
    {
        _responses[code.ToString()] = new Dictionary<string, object>
        {
            ["description"] = desc,
            ["content"] = new Dictionary<string, object>
            {
                [contentType] = new Dictionary<string, object> { ["schema"] = schema },
            },
        };
        return this;
    }

    public Dictionary<string, object> Build()
    {
        var op = new Dictionary<string, object>();
        if (_tag != null)   op["tags"] = new[] { _tag };
        if (_opId != null)  op["operationId"] = _opId;
        if (_params.Count > 0) op["parameters"] = _params;
        if (_reqSchema != null)
        {
            op["requestBody"] = new Dictionary<string, object>
            {
                ["required"] = true,
                ["content"] = new Dictionary<string, object>
                {
                    [_reqContentType!] = new Dictionary<string, object> { ["schema"] = _reqSchema },
                },
            };
        }
        op["responses"] = _responses;
        return op;
    }
}
