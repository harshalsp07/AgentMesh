// src/ai.mjs — Universal Multi-Provider AI Coordination Gateway
// Connects AgentMesh to Google Antigravity/Gemini, OpenAI, Anthropic, Ollama, DeepSeek, OpenRouter, and Groq.

export const SUPPORTED_PROVIDERS = {
  gemini: {
    name: 'Google Antigravity & Gemini',
    description: 'High-speed reasoning and deep context window multi-agent provider.',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    envKey: 'GEMINI_API_KEY',
    authType: 'query_or_header',
  },
  openai: {
    name: 'OpenAI',
    description: 'Industry-standard GPT-4o, o1, o3-mini models with JSON schema tool calling.',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini', 'gpt-4-turbo'],
    envKey: 'OPENAI_API_KEY',
    authType: 'bearer',
  },
  anthropic: {
    name: 'Anthropic Claude',
    description: 'Claude 3.7 Sonnet & 3.5 Haiku with exceptional software engineering capabilities.',
    defaultModel: 'claude-3-7-sonnet',
    models: ['claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-5-haiku', 'claude-3-opus'],
    envKey: 'ANTHROPIC_API_KEY',
    authType: 'header_x_api_key',
  },
  ollama: {
    name: 'Ollama (Local & Offline)',
    description: 'Zero-cloud, 100% private local LLM running directly on your workstation.',
    defaultModel: 'llama3.3',
    defaultEndpoint: 'http://localhost:11434',
    models: ['llama3.3', 'deepseek-r1', 'qwen2.5-coder', 'mistral', 'phi4'],
    envKey: 'OLLAMA_HOST',
    authType: 'none',
  },
  deepseek: {
    name: 'DeepSeek',
    description: 'DeepSeek V3 and DeepSeek R1 reasoning models with math and code proficiency.',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    envKey: 'DEEPSEEK_API_KEY',
    authType: 'bearer',
  },
  openrouter: {
    name: 'OpenRouter',
    description: 'Unified router bridging hundreds of open and proprietary AI models.',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'google/gemini-2.5-flash', 'deepseek/deepseek-r1'],
    envKey: 'OPENROUTER_API_KEY',
    authType: 'bearer',
  },
  groq: {
    name: 'Groq Cloud',
    description: 'Ultra-low latency LPU inference engine for lightning-fast swarm orchestration.',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    envKey: 'GROQ_API_KEY',
    authType: 'bearer',
  },
};

export function listProviders() {
  const result = {};
  for (const [id, prov] of Object.entries(SUPPORTED_PROVIDERS)) {
    result[id] = {
      ...prov,
      configuredInEnv: !!process.env[prov.envKey],
    };
  }
  return result;
}

export async function pingProvider(providerId, options = {}) {
  const prov = SUPPORTED_PROVIDERS[providerId];
  if (!prov) return { ok: false, error: `Unknown provider: ${providerId}` };

  const apiKey = options.apiKey || (prov.envKey ? process.env[prov.envKey] : '');
  const endpoint = options.endpoint || prov.defaultEndpoint;

  if (providerId === 'ollama') {
    try {
      const url = `${(endpoint || 'http://localhost:11434').replace(/\/$/, '')}/api/tags`;
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        const models = (data.models || []).map((m) => m.name);
        return { ok: true, status: 'online', models: models.length ? models : prov.models };
      }
      return { ok: false, error: `Ollama returned HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: `Cannot reach Ollama at ${endpoint || 'http://localhost:11434'}: ${err.message}` };
    }
  }

  if (!apiKey) {
    return { ok: false, error: `API key not configured for ${prov.name}` };
  }

  return { ok: true, status: 'ready', keyConfigured: true };
}

export async function executeChatCompletion(params = {}) {
  const {
    provider = 'gemini',
    model,
    messages = [],
    apiKey,
    endpoint,
    temperature = 0.7,
    maxTokens = 1500,
    actor = 'swarm-agent',
  } = params;

  const prov = SUPPORTED_PROVIDERS[provider];
  if (!prov) {
    return { ok: false, error: `Unsupported provider: ${provider}` };
  }

  const effectiveKey = apiKey || (prov.envKey ? process.env[prov.envKey] : '');
  const targetModel = model || prov.defaultModel;

  // 1. Ollama local
  if (provider === 'ollama') {
    const base = (endpoint || prov.defaultEndpoint || 'http://localhost:11434').replace(/\/$/, '');
    try {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: targetModel,
          messages: messages.map((m) => ({ role: m.role || 'user', content: m.content || '' })),
          stream: false,
          options: { temperature },
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const errText = await res.text();
        return { ok: false, error: `Ollama error (${res.status}): ${errText}` };
      }
      const data = await res.json();
      return {
        ok: true,
        provider: 'ollama',
        model: targetModel,
        content: data.message?.content || '',
        usage: { promptTokens: data.prompt_eval_count || 0, completionTokens: data.eval_count || 0 },
      };
    } catch (err) {
      return { ok: false, error: `Ollama connection failed: ${err.message}` };
    }
  }

  // 2. Google Gemini / Antigravity
  if (provider === 'gemini') {
    if (!effectiveKey) {
      return {
        ok: false,
        error: 'Missing Google Gemini API key. Configure it in Settings or set GEMINI_API_KEY environment variable.',
      };
    }
    try {
      // Map messages to Gemini contents format
      const contents = [];
      let systemInstruction = null;
      for (const m of messages) {
        if (m.role === 'system') {
          systemInstruction = { parts: [{ text: m.content }] };
        } else {
          contents.push({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          });
        }
      }
      if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Hello' }] });

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${encodeURIComponent(effectiveKey)}`;
      const reqBody = { contents };
      if (systemInstruction) reqBody.systemInstruction = systemInstruction;
      if (temperature !== undefined) reqBody.generationConfig = { temperature, maxOutputTokens: maxTokens };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        return { ok: false, error: `Google Gemini error (${res.status}): ${errJson?.error?.message || res.statusText}` };
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return {
        ok: true,
        provider: 'gemini',
        model: targetModel,
        content: text,
        usage: data.usageMetadata ? {
          promptTokens: data.usageMetadata.promptTokenCount,
          completionTokens: data.usageMetadata.candidatesTokenCount,
        } : null,
      };
    } catch (err) {
      return { ok: false, error: `Gemini request failed: ${err.message}` };
    }
  }

  // 3. Anthropic Claude
  if (provider === 'anthropic') {
    if (!effectiveKey) {
      return {
        ok: false,
        error: 'Missing Anthropic API key. Configure it in Settings or set ANTHROPIC_API_KEY.',
      };
    }
    try {
      let systemPrompt = '';
      const promptMessages = [];
      for (const m of messages) {
        if (m.role === 'system') systemPrompt += (systemPrompt ? '\n\n' : '') + m.content;
        else promptMessages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
      }
      if (!promptMessages.length) promptMessages.push({ role: 'user', content: 'Hello' });

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': effectiveKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: targetModel,
          messages: promptMessages,
          system: systemPrompt || undefined,
          max_tokens: maxTokens,
          temperature,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        return { ok: false, error: `Anthropic error (${res.status}): ${errJson?.error?.message || res.statusText}` };
      }

      const data = await res.json();
      const text = data.content?.[0]?.text || '';
      return {
        ok: true,
        provider: 'anthropic',
        model: targetModel,
        content: text,
        usage: { promptTokens: data.usage?.input_tokens, completionTokens: data.usage?.output_tokens },
      };
    } catch (err) {
      return { ok: false, error: `Anthropic request failed: ${err.message}` };
    }
  }

  // 4. OpenAI & OpenAI-compatible (DeepSeek, OpenRouter, Groq)
  const openAiEndpoints = {
    openai: 'https://api.openai.com/v1/chat/completions',
    deepseek: 'https://api.deepseek.com/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    groq: 'https://api.groq.com/openai/v1/chat/completions',
  };

  const targetUrl = endpoint || openAiEndpoints[provider];
  if (targetUrl) {
    if (!effectiveKey) {
      return {
        ok: false,
        error: `Missing API key for ${prov.name}. Configure it in Settings or set ${prov.envKey}.`,
      };
    }
    try {
      const headers = {
        'content-type': 'application/json',
        authorization: `Bearer ${effectiveKey}`,
      };
      if (provider === 'openrouter') {
        headers['HTTP-Referer'] = 'https://agentmesh.dev';
        headers['X-Title'] = 'AgentMesh Swarm Coordinator';
      }

      const res = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: targetModel,
          messages: messages.map((m) => ({ role: m.role || 'user', content: m.content || '' })),
          temperature,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        return { ok: false, error: `${prov.name} error (${res.status}): ${errJson?.error?.message || res.statusText}` };
      }

      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      return {
        ok: true,
        provider,
        model: targetModel,
        content: text,
        usage: {
          promptTokens: data.usage?.prompt_tokens,
          completionTokens: data.usage?.completion_tokens,
        },
      };
    } catch (err) {
      return { ok: false, error: `${prov.name} request failed: ${err.message}` };
    }
  }

  return { ok: false, error: `Unhandled provider dispatch: ${provider}` };
}
