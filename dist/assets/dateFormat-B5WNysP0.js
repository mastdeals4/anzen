import{c as i}from"./index-Am3NB057.js";/**
 * @license lucide-react v0.344.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const d=i("Search",[["circle",{cx:"11",cy:"11",r:"8",key:"4ej97u"}],["path",{d:"m21 21-4.3-4.3",key:"1qie3q"}]]),S=(r,e=!1)=>{if(!r)return"";const t=typeof r=="string"?new Date(r):r;if(Number.isNaN(t.getTime()))return"";const o=String(t.getDate()).padStart(2,"0"),s=String(t.getMonth()+1).padStart(2,"0"),c=t.getFullYear();if(!e)return`${o}/${s}/${c}`;const n=String(t.getHours()).padStart(2,"0"),a=String(t.getMinutes()).padStart(2,"0");return`${o}/${s}/${c} ${n}:${a}`},u=r=>{if(!r)return"";const e=r.trim();if(/^\d{4}-\d{2}-\d{2}$/.test(e))return e;if(/^\d{4}-\d{2}-\d{2}T/.test(e))return e.split("T")[0];const t=e.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);if(!t)return"";const[,o,s,c]=t,n=Number(o),a=Number(s);return n<1||n>31||a<1||a>12?"":`${c}-${String(a).padStart(2,"0")}-${String(n).padStart(2,"0")}`},f=u;export{d as S,S as f,f as n,u as t};
