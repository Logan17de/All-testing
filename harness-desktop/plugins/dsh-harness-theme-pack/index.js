export const name = 'dsh-harness-theme-pack';
export const inject = [];

export function apply(ctx) {
  ctx.logger?.info?.('Harness Desktop theme pack loaded.');
}

export default { name, inject, apply };
