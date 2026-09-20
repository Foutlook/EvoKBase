export const name='evokbase-guard';
export const inject=['tools'];
export function apply(ctx) {
  ctx.tools.guard(()=>'本次任务只允许整理提供的文本，禁止调用工具。');
  ctx.on('agent/created',({agent})=>agent.ctx.tools.restrict({allow:[]}));
  ctx.provide('evokbaseGuard',true);
}
