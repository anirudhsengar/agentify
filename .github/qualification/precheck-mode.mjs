export function configureLocalReview(options) {
 const task=JSON.parse(options.userPrompt);
 const model=options.config.models?.primary;
 if(task.source_precheck!==true||model?.provider!=='minimax'||model?.model!=='MiniMax-M3') return options;
 return {...options,config:{...options.config,thinkingLevel:'off'}};
}
