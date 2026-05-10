/* repoDNA — shared: DNA helix animation + typewriter logo */

function makeDna(svgId, accentColor) {
  const ns  = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById(svgId);
  if (!svg) return;

  const W=28,H=44,CX=W/2,CY=H/2;
  const PAIRS=7,RADIUS=7,HEIGHT=38,TWIST=Math.PI*2;
  const SPIN=0.016,PREC=0.009,TILT=0.30;
  const G = accentColor || '#20e3a0';
  let t = 0;

  const dep = z => { const k=(z+1)/2; return {op:0.28+k*0.72, sw:0.9+k*1.6, r:1.2+k*1.5}; };
  const mL  = (x1,y1,x2,y2,c,sw,op) => {
    const e=document.createElementNS(ns,'line');
    e.setAttribute('x1',x1.toFixed(2)); e.setAttribute('y1',y1.toFixed(2));
    e.setAttribute('x2',x2.toFixed(2)); e.setAttribute('y2',y2.toFixed(2));
    e.setAttribute('stroke',c); e.setAttribute('stroke-width',sw.toFixed(2));
    e.setAttribute('stroke-linecap','round'); e.setAttribute('opacity',op.toFixed(2));
    return e;
  };
  const mC = (x,y,r,f,op) => {
    const e=document.createElementNS(ns,'circle');
    e.setAttribute('cx',x.toFixed(2)); e.setAttribute('cy',y.toFixed(2));
    e.setAttribute('r',r.toFixed(2)); e.setAttribute('fill',f); e.setAttribute('opacity',op.toFixed(2));
    return e;
  };

  function frame() {
    t++;
    const spin=t*SPIN, prec=t*PREC;
    const tX=Math.sin(prec)*TILT, tZ=Math.cos(prec)*TILT;
    const els=[], pts=[];
    for (let i=0; i<=PAIRS; i++) {
      const fr=i/PAIRS, t0=fr-0.5, a=fr*TWIST+spin;
      const axX=CX+t0*HEIGHT*Math.sin(tX);
      const axY=CY+t0*HEIGHT*Math.cos(tX)*Math.cos(tZ);
      const axZ=t0*HEIGHT*Math.sin(tZ);
      pts.push({x1:axX+Math.cos(a)*RADIUS, y1:axY,
                x2:axX+Math.cos(a+Math.PI)*RADIUS, y2:axY,
                z1:Math.sin(a)+axZ/HEIGHT, z2:Math.sin(a+Math.PI)+axZ/HEIGHT});
    }
    for (let i=0; i<pts.length; i++) {
      const p=pts[i];
      const rz=(p.z1+p.z2)/2, rd=dep(rz);
      els.push({z:rz, el:mL(p.x1,p.y1,p.x2,p.y2,'#8b949e',rd.sw*0.55,rd.op*0.45)});
      if (i < pts.length-1) {
        const n=pts[i+1];
        const s1=(p.z1+n.z1)/2, d1=dep(s1); els.push({z:s1, el:mL(p.x1,p.y1,n.x1,n.y1,G,d1.sw,d1.op)});
        const s2=(p.z2+n.z2)/2, d2=dep(s2); els.push({z:s2, el:mL(p.x2,p.y2,n.x2,n.y2,'#db61a2',d2.sw,d2.op)});
      }
      const d1=dep(p.z1); els.push({z:p.z1, el:mC(p.x1,p.y1,d1.r,G,d1.op)});
      const d2=dep(p.z2); els.push({z:p.z2, el:mC(p.x2,p.y2,d2.r,'#f778ba',d2.op)});
    }
    els.sort((a,b) => a.z-b.z);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const f=document.createDocumentFragment();
    els.forEach(e => f.appendChild(e.el));
    svg.appendChild(f);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function typewriter(brandElId) {
  const FULL='repoDNA', REPO_N=4;
  const brand = document.getElementById(brandElId);
  if (!brand) return;
  const randDelay = () => 75 + Math.random() * 110;
  function renderTyped(n, done) {
    const repo = FULL.slice(0, Math.min(n, REPO_N));
    const dna  = FULL.slice(REPO_N, n);
    let h = '';
    if (repo) h += `<span class="dna-repo">${repo}</span>`;
    if (dna)  h += `<span class="dna-text${done ? ' done' : ''}">${dna}</span>`;
    h += `<span class="dna-cursor"></span>`;
    brand.innerHTML = h;
  }
  function type(i) {
    renderTyped(i, false);
    if (i < FULL.length) setTimeout(() => type(i+1), randDelay());
    else setTimeout(() => renderTyped(FULL.length, true), 150);
  }
  setTimeout(() => type(0), 500);
}
