import {
  fullscreenVertex,
  initLbmFragment,
  lbmStepFragment,
  macroFragment,
  impulseFragment,
  clearScalarFragment,
  scalarAdvectFragment,
  scalarCorrectFragment,
  scalarDiffuseFragment,
  scalarSourceFragment,
  scalarSplatFragment,
  renderFragment,
} from './plume-shaders.js';

(() => {
const canvas = document.querySelector('#plume-home-canvas');
const hero = document.querySelector('#plume-hero');
if (!canvas || !hero) return;
const interactionTarget = hero;

const readConfig = (name, fallback) => {
  const value = Number(canvas.dataset[name]);
  return Number.isFinite(value) ? value : fallback;
};
const CONFIG = Object.freeze({
  ambient: readConfig('ambient', 0.004),
  jet: readConfig('jet', 0.0105),
  reynolds: readConfig('reynolds', 650),
  meander: readConfig('meander', 1.65),
  turbulence: readConfig('turbulence', 1.15),
  diffusion: readConfig('diffusion', 0.0025),
  sourceStrength: readConfig('sourceStrength', 1.55),
  opacityLight: readConfig('opacityLight', 0.4),
  opacityDark: readConfig('opacityDark', 0.38),
});

const gl = canvas.getContext('webgl2', {
  alpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: true,
  powerPreference: 'high-performance',
});
if (!gl) {
  hero.classList.add('plume-unavailable');
  console.info('Interactive plume disabled: WebGL2 unavailable.');
  return;
}
if (!gl.getExtension('EXT_color_buffer_float')) {
  hero.classList.add('plume-unavailable');
  console.info('Interactive plume disabled: floating-point render targets unavailable.');
  return;
}
hero.classList.add('plume-ready');
gl.disable(gl.DEPTH_TEST);
gl.disable(gl.CULL_FACE);
gl.disable(gl.BLEND);
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(info || 'Shader compilation failed');
  }
  return shader;
}
function createProgram(fragmentSource) {
  const p = gl.createProgram();
  const vs = compile(gl.VERTEX_SHADER, fullscreenVertex);
  const fs = compile(gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(info || 'Program link failed');
  }
  return p;
}

const programs = {
  init: createProgram(initLbmFragment),
  lbm: createProgram(lbmStepFragment),
  macro: createProgram(macroFragment),
  impulse: createProgram(impulseFragment),
  clearScalar: createProgram(clearScalarFragment),
  advect: createProgram(scalarAdvectFragment),
  correct: createProgram(scalarCorrectFragment),
  diffuse: createProgram(scalarDiffuseFragment),
  source: createProgram(scalarSourceFragment),
  splat: createProgram(scalarSplatFragment),
  render: createProgram(renderFragment),
};
const uniformCache = new WeakMap();
function u(program, name) {
  let m = uniformCache.get(program);
  if (!m) { m = new Map(); uniformCache.set(program, m); }
  if (!m.has(name)) m.set(name, gl.getUniformLocation(program, name));
  return m.get(name);
}
const vao = gl.createVertexArray();
gl.bindVertexArray(vao);

function createTexture(w, h, components) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (components === 1) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, null);
  else if (components === 2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, w, h, 0, gl.RG, gl.FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
  return t;
}
function createTarget(w, h, components = 1) {
  const texture = createTexture(w, h, components);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete');
  return { texture, fbo, width: w, height: h };
}
function createDistTarget(w, h) {
  const textures = [createTexture(w,h,4), createTexture(w,h,4), createTexture(w,h,4)];
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  textures.forEach((t,i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0+i, gl.TEXTURE_2D, t, 0));
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('LBM framebuffer incomplete');
  return { textures, fbo, width:w, height:h };
}
function disposeTarget(t) { if (!t) return; gl.deleteTexture(t.texture); gl.deleteFramebuffer(t.fbo); }
function disposeDist(t) { if (!t) return; t.textures.forEach(x=>gl.deleteTexture(x)); gl.deleteFramebuffer(t.fbo); }
function createDoubleTarget(w,h,components=1) {
  let read=createTarget(w,h,components), write=createTarget(w,h,components);
  return { get read(){return read;}, get write(){return write;}, swap(){[read,write]=[write,read];}, dispose(){disposeTarget(read);disposeTarget(write);} };
}
function createDoubleDist(w,h) {
  let read=createDistTarget(w,h), write=createDistTarget(w,h);
  return { get read(){return read;}, get write(){return write;}, swap(){[read,write]=[write,read];}, dispose(){disposeDist(read);disposeDist(write);} };
}
function bindTexture(unit, texture, program, name) {
  gl.activeTexture(gl.TEXTURE0+unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(u(program,name),unit);
}
function drawTarget(t) { gl.bindFramebuffer(gl.FRAMEBUFFER,t.fbo); gl.viewport(0,0,t.width,t.height); gl.drawArrays(gl.TRIANGLES,0,3); }
function drawDist(t) { gl.bindFramebuffer(gl.FRAMEBUFFER,t.fbo); gl.viewport(0,0,t.width,t.height); gl.drawArrays(gl.TRIANGLES,0,3); }

const SOURCE_Y_IN_HERO = 0.98;
let sourceY = SOURCE_Y_IN_HERO;
const JET_SIGMA = 0.028;
const JET_DIAMETER_SIGMAS = 2.8;

const INLET_RAMP_STEPS = 280;
const MIN_TAU_PLUS = 0.512;
let simW=600, simH=320;
let dist=null, velocity=null, scalar=null, scalarForward=null, scalarBackward=null;
let simSteps=0;

const ambient = () => CONFIG.ambient;
const jet = () => CONFIG.jet;
const reynolds = () => CONFIG.reynolds;
const meander = () => CONFIG.meander;
const inletTurbulence = () => CONFIG.turbulence;
const sourceStrength = () => CONFIG.sourceStrength;

function currentTauPlus() {
  const U = Math.max(0.008, jet()-ambient());
  const D = Math.max(6, JET_DIAMETER_SIGMAS*JET_SIGMA*simH);
  const nu = U*D/Math.max(150,reynolds());
  // Keep a resolved viscosity floor; report effective rather than requested Re.
  return Math.max(MIN_TAU_PLUS, Math.min(0.545, 0.5+3*nu));
}
function currentTauMinus() {
  // Equal relaxation times recover A3's BGK collision. A4's very long odd
  // relaxation time (up to 42 lattice steps) was unstable in regression tests.
  return currentTauPlus();
}
function currentInletRamp() {
  const r=Math.min(1,Math.max(0,simSteps/INLET_RAMP_STEPS));
  return r*r*(3-2*r);
}

// Deterministic xorshift RNG: resets reproduce the same turbulent realization.
let rngState = 0x8e7f2a31 >>> 0;
function random01() {
  let x=rngState;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  rngState=x>>>0;
  return rngState/4294967296;
}
function randomNormal() {
  const u1=Math.max(1e-9,random01());
  const u2=random01();
  return Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2);
}
function makeOU(tau, sigma) { return { value:0, tau, sigma }; }
function stepOU(o, dt) {
  const a=Math.exp(-dt/o.tau);
  o.value=a*o.value + o.sigma*Math.sqrt(Math.max(0,1-a*a))*randomNormal();
}
const inlet = {
  centre: makeOU(600,1),
  angle: makeOU(450,1),
  ambientVy: makeOU(900,1),
  speed: makeOU(350,1),
  mode0: makeOU(180,1),
  mode1: makeOU(110,1),
  mode2: makeOU(70,1),
  mode3: makeOU(40,1),
  centerShift:0, ambientVyNow:0, speedFactor:1, modes:[0,0,0,0],
};
function updateInletState() {
  for (const o of [inlet.centre,inlet.angle,inlet.ambientVy,inlet.speed,inlet.mode0,inlet.mode1,inlet.mode2,inlet.mode3]) stepOU(o,1);
  const m=meander();
  const t=inletTurbulence();
  const du=Math.max(0.01,jet()-ambient());
  const slowWave = Math.sin(simSteps*0.00155) + 0.42*Math.sin(simSteps*0.00071+1.3);
  inlet.centerShift = 0; // Fixed nozzle: the flow bends, the source does not wander.
  inlet.ambientVyNow = du*m*(0.035*inlet.ambientVy.value + 0.012*Math.sin(simSteps*0.00093+0.7));
  inlet.speedFactor = Math.max(0.78,Math.min(1.20,1+t*0.055*inlet.speed.value));
  // Dominant same-sign (sinuous) mode; weaker varicose/higher modes broaden the spectrum.
  inlet.modes[0] = du*(m*0.15*inlet.angle.value + t*0.030*inlet.mode0.value + m*0.05*slowWave);
  inlet.modes[1] = du*t*0.018*inlet.mode1.value;
  inlet.modes[2] = du*t*0.014*inlet.mode2.value;
  inlet.modes[3] = du*t*0.009*inlet.mode3.value;
}
function warmOU() {
  for (let i=0;i<650;i++) updateInletState();
}

function initDistributions(target) {
  const p=programs.init;
  gl.useProgram(p);
  gl.uniform1f(u(p,'uAmbient'),ambient());
  drawDist(target);
}
function clearScalar(target) { gl.useProgram(programs.clearScalar); drawTarget(target); }

function resetInlet() {
  rngState=0x8e7f2a31>>>0;
  for (const key of ['centre','angle','ambientVy','speed','mode0','mode1','mode2','mode3']) inlet[key].value=0;
  simSteps=0;
  warmOU();
}
function resetSimulation() {
  if (!dist || !scalar) return;
  resetInlet();
  initDistributions(dist.read);
  initDistributions(dist.write);
  // Start from a consistent uniform flow and inject smoke continuously.
  clearScalar(scalar.read);
  clearScalar(scalar.write);
  clearScalar(scalarForward);
  clearScalar(scalarBackward);
  reconstructVelocity();
}
function destroyTargets() {
  dist?.dispose(); if (velocity) disposeTarget(velocity); scalar?.dispose(); disposeTarget(scalarForward); disposeTarget(scalarBackward);
  dist=velocity=scalar=scalarForward=scalarBackward=null;
}
function allocateTargets(w,h) {
  destroyTargets(); simW=w; simH=h;
  dist=createDoubleDist(w,h);
  velocity=createTarget(w,h,4);
  scalar=createDoubleTarget(w,h,2);
  scalarForward=createTarget(w,h,2);
  scalarBackward=createTarget(w,h,2);
  resetSimulation();
}

function lbmStep() {
  updateInletState();
  const p=programs.lbm;
  gl.useProgram(p);
  bindTexture(0,dist.read.textures[0],p,'uFA');
  bindTexture(1,dist.read.textures[1],p,'uFB');
  bindTexture(2,dist.read.textures[2],p,'uFC');
  gl.uniform1f(u(p,'uTauPlus'),currentTauPlus());
  gl.uniform1f(u(p,'uTauMinus'),currentTauMinus());
  const smoothRamp=currentInletRamp();
  gl.uniform1f(u(p,'uAmbient'),ambient());
  gl.uniform1f(u(p,'uAmbientVy'),inlet.ambientVyNow*smoothRamp);
  gl.uniform1f(u(p,'uJet'),ambient() + (jet()-ambient())*smoothRamp);
  gl.uniform1f(u(p,'uJetSigma'),JET_SIGMA);
  gl.uniform1f(u(p,'uSourceY'),sourceY);
  gl.uniform1f(u(p,'uCenterShift'),inlet.centerShift*smoothRamp);
  gl.uniform1f(u(p,'uJetSpeedFactor'),inlet.speedFactor);
  gl.uniform4f(u(p,'uInletModes'),...inlet.modes.map(v=>v*smoothRamp));
  drawDist(dist.write);
  dist.swap();
  simSteps++;
}
function reconstructVelocity() {
  const p=programs.macro;
  gl.useProgram(p);
  bindTexture(0,dist.read.textures[0],p,'uFA');
  bindTexture(1,dist.read.textures[1],p,'uFB');
  bindTexture(2,dist.read.textures[2],p,'uFC');
  drawTarget(velocity);
}
function impulseFlow(point,deltaU,radius) {
  const p=programs.impulse;
  gl.useProgram(p);
  bindTexture(0,dist.read.textures[0],p,'uFA');
  bindTexture(1,dist.read.textures[1],p,'uFB');
  bindTexture(2,dist.read.textures[2],p,'uFC');
  gl.uniform2f(u(p,'uPoint'),point[0],point[1]);
  gl.uniform2f(u(p,'uDeltaU'),deltaU[0],deltaU[1]);
  gl.uniform1f(u(p,'uRadius'),radius);
  gl.uniform2f(u(p,'uAspect'),canvas.width/canvas.height,1);
  drawDist(dist.write); dist.swap();
}
function advectScalar(stepScale) {
  let p=programs.advect;
  gl.useProgram(p);
  bindTexture(0,scalar.read.texture,p,'uScalar'); bindTexture(1,velocity.texture,p,'uVelocity');
  gl.uniform2f(u(p,'uTexelSize'),1/simW,1/simH); gl.uniform1f(u(p,'uStepScale'),stepScale); gl.uniform1f(u(p,'uDissipation'),1.0);
  drawTarget(scalarForward);

  gl.useProgram(p);
  bindTexture(0,scalarForward.texture,p,'uScalar'); bindTexture(1,velocity.texture,p,'uVelocity');
  gl.uniform2f(u(p,'uTexelSize'),1/simW,1/simH); gl.uniform1f(u(p,'uStepScale'),-stepScale); gl.uniform1f(u(p,'uDissipation'),1.0);
  drawTarget(scalarBackward);

  p=programs.correct;
  gl.useProgram(p);
  bindTexture(0,scalar.read.texture,p,'uOriginal'); bindTexture(1,scalarForward.texture,p,'uForward'); bindTexture(2,scalarBackward.texture,p,'uBackward'); bindTexture(3,velocity.texture,p,'uVelocity');
  gl.uniform2f(u(p,'uTexelSize'),1/simW,1/simH); gl.uniform1f(u(p,'uStepScale'),stepScale); gl.uniform1f(u(p,'uDissipation'),Math.exp(-0.000035*stepScale));
  drawTarget(scalar.write); scalar.swap();
}
function diffuseScalar(stepScale) {
  const p=programs.diffuse;
  gl.useProgram(p); bindTexture(0,scalar.read.texture,p,'uScalar');
  const k=Math.min(0.20,CONFIG.diffusion*Math.max(1,stepScale));
  gl.uniform1f(u(p,'uK'),k); drawTarget(scalar.write); scalar.swap();
}
function injectSource() {
  const smoothRamp=currentInletRamp();
  const p=programs.source;
  gl.useProgram(p); bindTexture(0,scalar.read.texture,p,'uScalar');
  gl.uniform1f(u(p,'uSourceY'),sourceY);
  gl.uniform1f(u(p,'uCenterShift'),inlet.centerShift*smoothRamp);
  gl.uniform1f(u(p,'uSigmaY'),JET_SIGMA*0.50);
  gl.uniform1f(u(p,'uSigmaX'),0.0075);
  gl.uniform1f(u(p,'uLevel'),sourceStrength());
  gl.uniform1f(u(p,'uX'),0.014);
  drawTarget(scalar.write); scalar.swap();
}
function splatScalar(point,radius,amount) {
  const p=programs.splat;
  gl.useProgram(p); bindTexture(0,scalar.read.texture,p,'uScalar');
  gl.uniform2f(u(p,'uPoint'),point[0],point[1]); gl.uniform1f(u(p,'uRadius'),radius); gl.uniform1f(u(p,'uAmount'),amount);
  gl.uniform2f(u(p,'uAspect'),canvas.width/canvas.height,1); drawTarget(scalar.write); scalar.swap();
}
function render() {
  gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.viewport(0,0,canvas.width,canvas.height);
  gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.disable(gl.BLEND); // Shader writes premultiplied RGBA directly.
  const p=programs.render;
  gl.useProgram(p);
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const color = dark ? [0.64,0.35,0.94] : [0.29,0.025,0.57];
  gl.uniform3f(u(p,'uTracerColor'),...color);
  gl.uniform1f(u(p,'uThemeDark'),dark ? 1.0 : 0.0);
  bindTexture(0,scalar.read.texture,p,'uScalar');
  const visibleAge=simSteps;
  const fade=Math.min(1,visibleAge/90);
  const opacity=(dark ? CONFIG.opacityDark : CONFIG.opacityLight)*fade;
  gl.uniform2f(u(p,'uTexelSize'),1/simW,1/simH); gl.uniform1f(u(p,'uOpacity'),opacity);
  gl.drawArrays(gl.TRIANGLES,0,3); gl.disable(gl.BLEND);
}

const diagnosticBuffer = new Float32Array(4);
function checkFlow() {
  gl.bindFramebuffer(gl.FRAMEBUFFER,velocity.fbo);
  gl.readPixels(Math.min(simW-1,12),Math.floor(sourceY*simH),1,1,gl.RGBA,gl.FLOAT,diagnosticBuffer);
  const [vx,vy,rho]=diagnosticBuffer;
  if(!Number.isFinite(vx+vy+rho) || rho<0.7 || rho>1.4 || Math.hypot(vx,vy)>0.3) {
    paused=true;
    hero.classList.add('plume-error');
    console.warn('Interactive plume paused after a flow-stability check failed.');
    return false;
  }
  return true;
}

function recommendedResolution() {
  const r=canvas.getBoundingClientRect();
  const aspect=Math.max(0.7, r.width/Math.max(1,r.height));
  const mobile=window.innerWidth<720;

  // Preserve the display aspect ratio exactly. For a full-bleed hero, capping
  // width and height independently would stretch the simulated eddies. Instead
  // choose a roughly fixed cell budget and derive both dimensions from it.
  const targetCells = mobile ? 70000 : 155000;
  let h=Math.round(Math.sqrt(targetCells/aspect));
  let w=Math.round(h*aspect);

  const minH=mobile?120:150, maxH=mobile?220:280;
  h=Math.max(minH,Math.min(maxH,h));
  w=Math.round(h*aspect);

  // Very wide monitors can otherwise become unnecessarily expensive. Keep the
  // aspect ratio when applying the final width ceiling.
  const maxW=mobile?520:960;
  if(w>maxW){
    w=maxW;
    h=Math.max(96,Math.round(w/aspect));
  }
  return [w,h];
}
function resize() {
  const r=canvas.getBoundingClientRect();
  const heroRect=hero.getBoundingClientRect();

  // B.3 lets the decorative canvas continue below the interactive hero. Keep
  // the physical source at the same screen-space height it had before the
  // extension instead of allowing SOURCE_Y to drift downward with the taller
  // canvas. UV y is bottom-up, hence this conversion.
  sourceY = 1 - (1 - SOURCE_Y_IN_HERO) * heroRect.height / Math.max(1,r.height);
  sourceY = Math.min(0.88,Math.max(0.12,sourceY));

  const dpr=Math.min(window.devicePixelRatio||1,2);
  const w=Math.max(2,Math.round(r.width*dpr)), h=Math.max(2,Math.round(r.height*dpr));
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
  const [rw,rh]=recommendedResolution();
  if(!dist||rw!==simW||rh!==simH) allocateTargets(rw,rh);
}

// Pointer events collect motion; simulation frames apply bounded impulses.
const pointer={active:false,inside:false,id:null,x:0,y:0,fx:0,fy:0};
function pointerUv(e) {
  const r=canvas.getBoundingClientRect();
  return [Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),Math.min(1,Math.max(0,1-(e.clientY-r.top)/r.height))];
}
function trackPointer(e) {
  if(pointer.id!==null && e.pointerId!==pointer.id)return;
  const [x,y]=pointerUv(e);
  if(pointer.active && pointer.inside && !paused) {
    pointer.fx+=(x-pointer.x)*0.35;
    pointer.fy+=(y-pointer.y)*0.35;
  }
  pointer.x=x;pointer.y=y;pointer.inside=true;
}
interactionTarget.addEventListener('pointerdown',e=>{
  if(pointer.id!==null || (e.pointerType==='mouse' && e.button!==0))return;
  if(e.target.closest('a, button, input, select, textarea, [role="button"], figure, img, .profile'))return;
  hero.classList.add('plume-interacted');
  pointer.inside=false;trackPointer(e);pointer.active=true;pointer.id=e.pointerId;
  if(e.pointerType!=='touch') interactionTarget.setPointerCapture(e.pointerId);
  if(!paused)splatScalar([pointer.x,pointer.y],0.016,0.25);
});
interactionTarget.addEventListener('pointermove',e=>{
  if(!pointer.active)return;
  trackPointer(e);
});
function endPointer(e){
  if(e.pointerId!==pointer.id)return;
  pointer.active=false;pointer.id=null;
  if(interactionTarget.hasPointerCapture(e.pointerId))interactionTarget.releasePointerCapture(e.pointerId);
  if(e.pointerType==='touch')pointer.inside=false;
}
interactionTarget.addEventListener('pointerup',endPointer);
interactionTarget.addEventListener('pointercancel',endPointer);
interactionTarget.addEventListener('lostpointercapture',endPointer);
interactionTarget.addEventListener('pointerleave',()=>{if(!pointer.active){pointer.inside=false;pointer.fx=pointer.fy=0;}});
window.addEventListener('blur',()=>{pointer.active=false;pointer.id=null;pointer.inside=false;pointer.fx=pointer.fy=0;});
function applyPointerMotion() {
  const magnitude=Math.hypot(pointer.fx,pointer.fy);
  if(magnitude>0) {
    const scale=Math.min(1,0.008/magnitude);
    impulseFlow([pointer.x,pointer.y],[pointer.fx*scale,pointer.fy*scale],0.032);
  }
  pointer.fx=pointer.fy=0;
}

let paused=false,inViewport=true,lastTime=performance.now(),accumulator=0,frames=0,fpsStart=lastTime,raf=0;
const STEPS_PER_SECOND=720;
const FIXED_STEP=1/STEPS_PER_SECOND;
function frame(now) {
  raf=requestAnimationFrame(frame); resize();
  if(paused||document.hidden||!inViewport){lastTime=now;accumulator=0;pointer.fx=pointer.fy=0;return;}
  const realDt=Math.min(0.05,Math.max(0,(now-lastTime)/1000));
  lastTime=now; accumulator=Math.min(accumulator+realDt,16*FIXED_STEP);
  if(accumulator>=FIXED_STEP)applyPointerMotion();
  let n=0;
  while(accumulator>=FIXED_STEP&&n<16){lbmStep();accumulator-=FIXED_STEP;n++;}
  if(n>0){
    reconstructVelocity();
    {
      // Subcycle scalar transport. This keeps source injection temporally
      // continuous instead of moving one large chunk once per display frame.
      let remaining=n;
      while(remaining>0){
        const ds=Math.min(4,remaining);
        advectScalar(ds);
        diffuseScalar(ds);
        injectSource();
        if(pointer.active)splatScalar([pointer.x,pointer.y],0.016,0.025*ds);
        remaining-=ds;
      }

    }
  }
  render(); frames++;
  if(now-fpsStart>900){
    checkFlow();
    frames=0; fpsStart=now;
  }
}

window.addEventListener('resize',resize,{passive:true});
document.addEventListener('visibilitychange',()=>{lastTime=performance.now();accumulator=0;});

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    inViewport = entries[0]?.isIntersecting ?? true;
    lastTime=performance.now(); accumulator=0;
  }, { rootMargin: '180px 0px' });
  observer.observe(hero);
  window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});
}

const reduceMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
if(reduceMotion.matches){
  paused=true;
  hero.classList.add('plume-reduced-motion');
}

resize(); raf=requestAnimationFrame(frame);
window.addEventListener('pagehide',()=>cancelAnimationFrame(raf),{once:true});
})();
