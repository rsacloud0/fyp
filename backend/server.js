require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ThinkIA backend running' });
});

// Main proxy route — forwards requests to Anthropic
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, system, max_tokens } = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 1200,
        system,
        messages
      })
    });

    const data = await response.json();
    res.json(data);

  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.listen(PORT, () => {
  console.log(`ThinkIA backend running on port ${PORT}`);
});
```

**'backend/.env'**
```
ANTHROPIC_API_KEY=your_actual_api_key_here