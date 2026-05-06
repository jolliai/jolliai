# API Reference

The DevKit API is organized around REST. All endpoints accept JSON request bodies and return JSON responses.

## Base URL

```
https://api.devkit.dev/v1
```

## Authentication

Use your API key in the `Authorization` header:

```
Authorization: Bearer dk_live_xxx
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/process` | Process a document |
| GET | `/process/{id}` | Get processing result |
| GET | `/usage` | Get current usage stats |
