import assert from 'node:assert/strict';
/** Evaluation only: same M3 and canonical gates; no production configuration change. */
export function reviewPhaseConfig(config,precheck){
 assert.equal(config.provider,'minimax');
 assert.deepEqual(config.models.primary,{provider:'minimax',model:'MiniMax-M3'});
 return precheck?config:{...config,thinkingLevel:'off'};
}
