import React from 'react';
import {createRoot} from 'react-dom/client';
import {OpenGenerativeUIActivityRenderer,SandboxFunctionsContext,OpenGenerativeUIContentSchema} from '@copilotkit/react-core/v2';
import {z} from 'zod';
import {skel} from '../public/skeleton.js';
const roots=new Map();
const functions=[{name:'sendPrompt',description:'Ask a follow-up question after the user clicks an interface control.',parameters:z.object({text:z.string().min(1).max(3000)}),handler:async args=>{if(!navigator.userActivation.isActive)throw new Error('Click an interface control to ask a follow-up.');const {text}=z.object({text:z.string().min(1).max(3000)}).parse(args);document.dispatchEvent(new CustomEvent('acres-follow-up',{detail:{text}}));return {queued:true};}}];
const csp="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none';";
// The sandbox document follows the app's theme: its color scheme and the app's surface, ink and line
// colors as CSS variables, with a base style the agent's HTML inherits. The agent's own CSS comes
// after this base, so it still decides anything it sets explicitly.
const THEME_VARS=['--bg','--surface','--surface-2','--surface-3','--ink','--ink-muted','--ink-faint','--line','--line-strong','--accent','--on-accent','--success','--warning','--danger','--info','--r-sm','--r-md','--r-lg'];
export function themeCss(root=document.documentElement){
  const computed=getComputedStyle(root);
  const vars=THEME_VARS.map(name=>{const value=computed.getPropertyValue(name).trim();return value&&!/[;{}<]/.test(value)?`${name}:${value};`:'';}).join('');
  const scheme=root.classList.contains('dark')?'dark':'light';
  return `:root{color-scheme:${scheme};${vars}}html,body{background:transparent;color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;}a{color:inherit;}button,input,select,textarea{font:inherit;color:inherit;accent-color:var(--ink);}table{border-color:var(--line);}`;
}
const themed=new Set();
new MutationObserver(()=>{for(const update of themed)update();}).observe(document.documentElement,{attributes:true,attributeFilter:['class']});
window.acresGeneratedUi={
  render(container,value) {
    const content=OpenGenerativeUIContentSchema.parse(value);
    const html=content.html.join('').replace(/<head[^>]*>/i,'').replace(/<\/head>/i,'');
    content.html=[`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style id="acres-theme">${themeCss()}</style></head><body inert>${html}</body></html>`];
    content.jsExpressions=[...(content.jsExpressions||[]),`(function(){var style=document.createElement('style');style.textContent='html,body{height:auto!important;min-height:0!important}';document.head.appendChild(style);var last=0;function measure(){requestAnimationFrame(function(){var cs=getComputedStyle(document.body);var height=Math.ceil(document.body.scrollHeight+(parseFloat(cs.marginTop)||0)+(parseFloat(cs.marginBottom)||0));var bounded=Math.max(100,Math.min(2400,height));document.documentElement.style.setProperty('overflow',height>2400?'auto':'hidden','important');document.body.style.setProperty('overflow',height>2400?'auto':'hidden','important');if(bounded!==last){last=bounded;Websandbox.connection.remote.resizeView({height:bounded});}});}new ResizeObserver(measure).observe(document.body);addEventListener('resize',measure);document.fonts.ready.then(measure);measure();document.body.inert=false;Websandbox.connection.remote.interfaceReady({});})();`];
    // The view's frame holds its place, at its first height, until the sandbox reports it is ready.
    const ready=document.createElement("div");ready.className="generated-skeleton";ready.setAttribute("role","status");ready.style.height=Math.max(100,content.initialHeight||200)+"px";
    const hint=document.createElement("span");hint.className="sr-only";hint.textContent="Preparing the interactive view";
    ready.append(hint,skel("skel-text",{width:"38%",height:"16px"}),skel("skel-text",{width:"62%"}),skel("skel-block",{flex:"1",minHeight:"40px"}));container.append(ready);
    let view={...content,generating:true};
    const bridge=[...functions,{name:"resizeView",parameters:z.object({height:z.number().int().min(100).max(2400)}),handler:async args=>{const {height}=z.object({height:z.number().int().min(100).max(2400)}).parse(args);host.style.setProperty("--acres-ui-height",height+"px");return {};}},{name:"interfaceReady",parameters:z.object({}),handler:async()=>{ready.remove();host.classList.remove("is-preparing");view={...view,generating:false};display();return {};}}];
    const host=document.createElement("div");host.className="acres-sandbox is-preparing";host.style.setProperty("--acres-ui-height",content.initialHeight+"px");container.append(host);
    const root=createRoot(host);roots.set(container,root);
    const display=()=>root.render(<SandboxFunctionsContext.Provider value={bridge}><OpenGenerativeUIActivityRenderer activityType="open-generative-ui" content={view} message={{}} agent={null}/></SandboxFunctionsContext.Provider>);
    // A theme switch restyles the open view in place, so its inputs and state survive.
    const retheme=()=>{view={...view,jsExpressions:[...view.jsExpressions,`document.getElementById('acres-theme').textContent=${JSON.stringify(themeCss())};`]};display();};
    themed.add(retheme);container.acresRetheme=retheme;
    display();
  },
  unmount(container){const root=roots.get(container);root?.unmount();roots.delete(container);themed.delete(container.acresRetheme);}
};
