import {DOMParser} from 'linkedom';
import {sanitizeSvg,extractPrimitives} from '../../public/plan-intake.js';
import {planFromSvg} from '../../../acres-research/architecture-tools.mjs';

process.once('message',({svg,action})=>{
  try{
    const value=action==='plan'
      ? planFromSvg(svg,{widthMetres:10,name:'SVG path fixture',ref:'fixture.svg'})
      : extractPrimitives(sanitizeSvg(svg,{DOMParser}).svg,{DOMParser});
    process.send({phase:'result',value});
  }catch(error){process.send({phase:'error',message:error.message});}
  process.disconnect();
});
process.send({phase:'ready'});
