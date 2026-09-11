import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleEvent, eventRecord } from '../templates/codex/knowledge-flow.mjs';

test('消息只注入范围判断与复用规则，不由处理器分类或启动角色', () => {
  for (const prompt of ['继续', '你好', '读取规则', '停止']) {
    const output = handleEvent({ hook_event_name: 'UserPromptSubmit', prompt });
    assert.match(output.hookSpecificOutput.additionalContext, /knowledge_retriever/);
    assert.match(output.hookSpecificOutput.additionalContext, /knowledge_reviewer/);
    assert.match(output.hookSpecificOutput.additionalContext, /仅业务分析、业务开发或用户明确要求查询知识库时调用/);
    assert.match(output.hookSpecificOutput.additionalContext, /普通问答、聊天、文档润色和非业务配置维护直接跳过查询与评审，不启动知识子 Agent/);
    assert.match(output.hookSpecificOutput.additionalContext, /已有查询覆盖且任务范围未变时复用结果/);
    assert.match(output.hookSpecificOutput.additionalContext, /仅对第 1 条适用范围内的任务/);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /每条普通用户消息先调用/);
    assert.match(output.hookSpecificOutput.additionalContext, /取消、停止、撤销授权优先立即执行/);
    assert.equal(output.decision, undefined);
  }
});

test('压缩恢复不建立新轮次；普通启动不重复注入', () => {
  assert.match(handleEvent({ hook_event_name: 'SessionStart', source: 'compact' }).hookSpecificOutput.additionalContext, /不因恢复事件重新查询/);
  assert.deepEqual(handleEvent({ hook_event_name: 'SessionStart', source: 'startup' }), {});
});

test('知识子 Agent 不继续派生；其他角色和停止事件不改变流程', () => {
  for (const agent_type of ['knowledge_retriever', 'knowledge_reviewer']) {
    assert.match(handleEvent({ hook_event_name: 'SubagentStart', agent_type }).hookSpecificOutput.additionalContext, /不得继续启动/);
    assert.deepEqual(handleEvent({ hook_event_name: 'SubagentStop', agent_type }), {});
  }
  assert.deepEqual(handleEvent({ hook_event_name: 'SubagentStart', agent_type: 'worker' }), {});
  assert.deepEqual(handleEvent({ hook_event_name: 'Stop' }), {});
});

test('日志仅保留事件元数据，不记录正文、路径和凭据', () => {
  const record = eventRecord({ hook_event_name: 'SubagentStop', agent_type: 'knowledge_reviewer', session_id: 's', turn_id: 't', agent_id: 'a', prompt: 'private', last_assistant_message: 'private', transcript_path: 'private', token: 'private' });
  assert.equal(record.agent_id, 'a');
  assert.equal(record.turn_id, 't');
  assert.doesNotMatch(JSON.stringify(record), /private/);
  assert.equal(eventRecord({ hook_event_name: 'SubagentStart', agent_type: 'worker' }), null);
});

test('畸形输入与超限输入返回可见失败，既不泄露输入也不阻止主任务', () => {
  const script = fileURLToPath(new URL('../templates/codex/knowledge-flow.mjs', import.meta.url));
  for (const input of ['private-not-json', 'null', '[]', 'x'.repeat(513 * 1024)]) {
    const result = spawnSync(process.execPath, [script], { input, encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.systemMessage, /未注入/);
    assert.equal(output.decision, undefined);
    assert.doesNotMatch(result.stdout, /private-not-json/);
  }
});
