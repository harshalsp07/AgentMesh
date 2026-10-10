// test/ai.test.mjs — Universal Multi-Provider AI Coordination Gateway tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { listProviders, pingProvider, executeChatCompletion, SUPPORTED_PROVIDERS } from '../src/ai.mjs';

test('Universal AI Gateway — Provider Registry', () => {
  const provs = listProviders();
  assert.ok(provs.gemini, 'Google Gemini/Antigravity present');
  assert.ok(provs.openai, 'OpenAI present');
  assert.ok(provs.anthropic, 'Anthropic present');
  assert.ok(provs.ollama, 'Ollama present');
  assert.ok(provs.deepseek, 'DeepSeek present');
  assert.ok(provs.openrouter, 'OpenRouter present');
  assert.ok(provs.groq, 'Groq present');
  assert.ok(provs.mistral, 'Mistral present');
  assert.ok(provs.xai, 'xAI present');
  assert.equal(provs.gemini.defaultModel, 'gemini-2.5-flash');
  assert.ok(provs.gemini.models.includes('gemini-2.5-pro'));
  assert.ok(provs.openai.models.includes('o3-mini'));
  assert.ok(provs.anthropic.models.includes('claude-3-7-sonnet'));
  assert.ok(provs.ollama.models.includes('deepseek-r1'));
});

test('Universal AI Gateway — Ping Validation', async () => {
  const resBad = await pingProvider('non-existent-provider');
  assert.equal(resBad.ok, false);

  const resGeminiNoKey = await pingProvider('gemini', { apiKey: '' });
  assert.equal(resGeminiNoKey.ok, false);

  const resGeminiKey = await pingProvider('gemini', { apiKey: 'dummy-test-key' });
  assert.equal(resGeminiKey.ok, true);
  assert.equal(resGeminiKey.status, 'ready');
});

test('Universal AI Gateway — Execution Error Handling', async () => {
  const resNoKey = await executeChatCompletion({
    provider: 'openai',
    apiKey: '',
    messages: [{ role: 'user', content: 'test' }],
  });
  assert.equal(resNoKey.ok, false);
  assert.match(resNoKey.error, /Missing API key/);
});
