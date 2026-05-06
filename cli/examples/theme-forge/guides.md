# Guides

Step-by-step guides for common tasks.

## Quick Start

```bash
npm install devkit
```

```javascript
import { DevKit } from 'devkit';

const client = new DevKit({ apiKey: 'your-key' });
const result = await client.process({ input: 'Hello' });
console.log(result);
```

## Authentication

All API requests require an API key passed in the `Authorization` header:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" https://api.devkit.dev/v1/process
```
