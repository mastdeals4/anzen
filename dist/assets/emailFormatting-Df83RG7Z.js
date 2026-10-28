import{K as k}from"./index-y9z6Nl5C.js";function v(s){if(!s)return"-";const i=Math.floor((Date.now()-new Date(s).getTime())/864e5);return i<=0?"0d":`${i}d`}function P(s){const t=((s==null?void 0:s.trim())||"").match(/make\s*:\s*([^,;\n|]+)/i);return((t==null?void 0:t[1])||"").trim()}function e(s){return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}function S(s,i){const t=i??k,n=e(s||""),r=t.company_email?`<span style="color:#0b66c3;">📧</span> <a href="mailto:${e(t.company_email)}" style="color:#0b66c3;text-decoration:underline;">${e(t.company_email)}</a>`:"";return`<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.45;font-size:14px;margin-top:18px;">
    <p style="margin:0 0 6px 0;">Warm regards,</p>
    <p style="margin:0 0 6px 0;">${n}</p>
    <p style="margin:0 0 4px 0;color:#073763;font-size:20px;font-weight:700;">${e(t.company_name)}</p>
    ${t.company_address?`<p style="margin:0 0 6px 0;">${e(t.company_address)}</p>`:""}
    ${r?`<p style="margin:0 0 2px 0;">${r}</p>`:""}
    ${t.company_phone?`<p style="margin:0 0 18px 0;color:#274e13;">📱 ${e(t.company_phone)}</p>`:""}
    <p style="margin:0;color:#073763;font-weight:700;font-style:italic;">APIs | Excipients | Formulations | Nutraceuticals | Herbal Extracts | Pharma Packaging Solutions | Technology Transfers</p>
  </div>`}function A(s){return`Pricing Request - ACE Ref ${[...new Set(s.map(t=>t.aceerp_no).filter(Boolean))].join(", ")}`}function D(s,i){const t="padding:10px 12px;border:1px solid #b7c9df;background:#073763;color:#ffffff;text-align:left;font-weight:700;font-size:13px;",n="padding:9px 12px;border:1px solid #d1d5db;color:#1f2937;font-size:13px;vertical-align:top;",r="padding:9px 12px;border:1px solid #d1d5db;color:#1f2937;font-size:13px;vertical-align:top;background:#fafff5;min-width:80px;",p=s.map((a,b)=>{var y,f,h,m,g,$,u;const _=b%2===0?"#ffffff":"#f8fafc",o=[];a.coa_required&&o.push("COA"),a.sample_required&&o.push("Sample"),a.agency_letter_required&&o.push("Agency Letter"),a.others_required&&o.push("Others");const q=a.delivery_date?new Date(a.delivery_date).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}):"-",d=v(a.created_at);return`<tr style="background:${_};">
      <td style="${n}font-weight:600;white-space:nowrap;">${e(((y=a.aceerp_no)==null?void 0:y.trim())||"-")}</td>
      <td style="${n}">${e(((f=a.company_name)==null?void 0:f.trim())||"-")}</td>
      <td style="${n}font-weight:600;">${e(((h=a.product_name)==null?void 0:h.trim())||"-")}</td>
      <td style="${n}">${e(((m=a.specification)==null?void 0:m.trim())||"-")}</td>
      <td style="${n}">${e(P(a.remarks)||((g=a.supplier_name)==null?void 0:g.trim())||"-")}</td>
      <td style="${n}white-space:nowrap;">${e((($=a.quantity)==null?void 0:$.trim())||"-")}</td>
      <td style="${n}white-space:nowrap;">${e(q)}</td>
      <td style="${n}text-align:center;font-weight:600;color:${parseInt(d)>30?"#b91c1c":parseInt(d)>14?"#d97706":"#059669"};">${e(d)}</td>
      <td style="${n}">${e(o.length>0?o.join(", "):"-")}</td>
      <td style="${r}">&nbsp;</td>
      <td style="${n}">${e(((u=a.remarks)==null?void 0:u.trim())||"-")}</td>
    </tr>`}).join(""),x=`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:1000px;font-family:Arial,Helvetica,sans-serif;font-size:13px;mso-table-lspace:0pt;mso-table-rspace:0pt;">
    <thead><tr>
      <th style="${t}">ACE ERP Ref</th><th style="${t}">Customer Name</th><th style="${t}">Product Name</th><th style="${t}">Specification</th><th style="${t}">Make</th><th style="${t}">Quantity</th><th style="${t}">Required Delivery Date</th><th style="${t}">Ageing (Days)</th><th style="${t}">Documents Required</th><th style="${t}">Price</th><th style="${t}">Remarks</th>
    </tr></thead><tbody>${p}</tbody>
  </table>`,l=i??k;let c="<p>Dear Team,</p><p>Please provide your best quotation for the following requirement.</p>";return c+=x,c+=`<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.45;font-size:14px;margin-top:18px;"><p style="margin:0 0 6px 0;">Thank you.</p><p style="margin:0 0 6px 0;">Best Regards,</p><p style="margin:0 0 6px 0;">Kunal Lunkad</p><p style="margin:0 0 4px 0;color:#073763;font-size:20px;font-weight:700;">${e(l.company_name)}</p>${l.company_address?`<p style="margin:0 0 6px 0;">${e(l.company_address)}</p>`:""}${l.company_email?`<p style="margin:0 0 2px 0;"><span style="color:#0b66c3;">📧</span> <a href="mailto:${e(l.company_email)}" style="color:#0b66c3;text-decoration:underline;">${e(l.company_email)}</a></p>`:""}${l.company_phone?`<p style="margin:0 0 18px 0;color:#274e13;">📱 ${e(l.company_phone)}</p>`:""}<p style="margin:0;color:#073763;font-weight:700;font-style:italic;">APIs | Excipients | Formulations | Nutraceuticals | Herbal Extracts | Pharma Packaging Solutions | Technology Transfers</p></div>`,c}function C(s){const i="padding:10px 12px;border:1px solid #b7c9df;background:#073763;color:#ffffff;text-align:left;font-weight:700;font-size:13px;",t="padding:9px 12px;border:1px solid #d1d5db;color:#1f2937;font-size:13px;vertical-align:top;",n=s.map((r,p)=>`<tr style="background:${p%2===0?"#ffffff":"#f8fafc"};">
      <td style="${t}font-weight:600;">${e(r.inquiryNumber)}</td>
      <td style="${t}">${e(r.aceerpNo||"-")}</td>
      <td style="${t}font-weight:600;">${e(r.product)}</td>
      <td style="${t}">${e(r.requiredMake||"-")}</td>
      <td style="${t}">${e(r.offeredMake||"-")}</td>
      <td style="${t}">${e(r.qty)}</td>
      <td style="${t}white-space:nowrap;">${e(r.inrSourcePrice)}</td>
      <td style="${t}white-space:nowrap;">${e(r.usdLandedCost)}</td>
      <td style="${t}font-weight:600;white-space:nowrap;">${e(r.quotePrice)}</td>
      <td style="${t}">${e(r.remarks||"-")}</td>
    </tr>`).join("");return`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:760px;font-family:Arial,Helvetica,sans-serif;font-size:13px;mso-table-lspace:0pt;mso-table-rspace:0pt;">
    <thead><tr>
      <th style="${i}">Inquiry No</th>
      <th style="${i}">AC ERP#</th>
      <th style="${i}">Product</th>
      <th style="${i}">Required Make</th>
      <th style="${i}">Offered Make</th>
      <th style="${i}">Qty</th>
      <th style="${i}">INR Source Price</th>
      <th style="${i}">USD Landed Cost</th>
      <th style="${i}">Quote Price</th>
      <th style="${i}">Remarks</th>
    </tr></thead>
    <tbody>${n}</tbody>
  </table>`}function w(s){const i=s.map(r=>{var p;return(p=r.aceerp_no)==null?void 0:p.trim()}).filter(r=>!!r),t=Array.from(new Set(i)),n=new Date().toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"});return t.length===1?`Inquiry Sourcing Request China – ${t[0]} – ${n}`:t.length>1?`Inquiry Sourcing Request China – ${t.length} Items – ${n}`:`Inquiry Sourcing Request China – ${s.length} Items – ${n}`}function z(s,i){const t="padding:10px 12px;border:1px solid #b7c9df;background:#073763;color:#ffffff;text-align:left;font-weight:700;font-size:13px;",n="padding:9px 12px;border:1px solid #d1d5db;color:#1f2937;font-size:13px;vertical-align:top;",r="padding:9px 12px;border:1px solid #d1d5db;background:#fff8e7;color:#78350f;font-weight:700;font-size:13px;vertical-align:top;",p=s.map((a,b)=>{var y,f,h,m,g,$,u;const _=b%2===0?"#ffffff":"#f8fafc",o=[];a.coa_required&&o.push("COA"),a.sample_required&&o.push("Sample"),a.agency_letter_required&&o.push("Agency Letter"),a.others_required&&o.push("Others");const q=a.delivery_date?new Date(a.delivery_date).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}):"-",d=v(a.created_at);return`<tr style="background:${_};">
      <td style="${n}font-weight:600;white-space:nowrap;">${e(((y=a.aceerp_no)==null?void 0:y.trim())||"-")}</td>
      <td style="${n}">${e(((f=a.company_name)==null?void 0:f.trim())||"-")}</td>
      <td style="${n}font-weight:600;">${e(((h=a.product_name)==null?void 0:h.trim())||"-")}</td>
      <td style="${n}">${e(((m=a.specification)==null?void 0:m.trim())||"-")}</td>
      <td style="${n}">${e(P(a.remarks)||((g=a.supplier_name)==null?void 0:g.trim())||"-")}</td>
      <td style="${n}white-space:nowrap;">${e((($=a.quantity)==null?void 0:$.trim())||"-")}</td>
      <td style="${n}white-space:nowrap;">${e(q)}</td>
      <td style="${n}text-align:center;font-weight:600;color:${parseInt(d)>30?"#b91c1c":parseInt(d)>14?"#d97706":"#059669"};">${e(d)}</td>
      <td style="${n}">${e(o.length>0?o.join(", "):"-")}</td>
      <td style="${r}">&nbsp;</td>
      <td style="${n}">${e(((u=a.remarks)==null?void 0:u.trim())||"-")}</td>
    </tr>`}).join(""),x=`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:1000px;font-family:Arial,Helvetica,sans-serif;font-size:13px;mso-table-lspace:0pt;mso-table-rspace:0pt;">
    <thead><tr>
      <th style="${t}">ACE ERP Ref</th><th style="${t}">Customer Name</th><th style="${t}">Product Name</th><th style="${t}">Specification</th><th style="${t}">Preferred Make</th><th style="${t}">Quantity</th><th style="${t}">Required Delivery Date</th><th style="${t}">Ageing (Days)</th><th style="${t}">Documents Required</th><th style="${t}">Price</th><th style="${t}">Remarks</th>
    </tr></thead><tbody>${p}</tbody>
  </table>`,l=i??k;let c="<p>Dear Team,</p><p>Please provide your best quotation for the following requirement.</p>";return c+=x,c+=`<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.45;font-size:14px;margin-top:18px;"><p style="margin:0 0 6px 0;">Thank you.</p><p style="margin:0 0 6px 0;">Best Regards,</p><p style="margin:0 0 6px 0;">Kunal Lunkad</p><p style="margin:0 0 4px 0;color:#073763;font-size:20px;font-weight:700;">${e(l.company_name)}</p>${l.company_address?`<p style="margin:0 0 6px 0;">${e(l.company_address)}</p>`:""}${l.company_email?`<p style="margin:0 0 2px 0;"><span style="color:#0b66c3;">📧</span> <a href="mailto:${e(l.company_email)}" style="color:#0b66c3;text-decoration:underline;">${e(l.company_email)}</a></p>`:""}${l.company_phone?`<p style="margin:0 0 18px 0;color:#274e13;">📱 ${e(l.company_phone)}</p>`:""}<p style="margin:0;color:#073763;font-weight:700;font-style:italic;">APIs | Excipients | Formulations | Nutraceuticals | Herbal Extracts | Pharma Packaging Solutions | Technology Transfers</p></div>`,c}export{S as a,C as b,D as c,A as d,e,w as f,z as g};
