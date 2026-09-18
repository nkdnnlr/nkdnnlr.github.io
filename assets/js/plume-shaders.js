export const fullscreenVertex = `#version 300 es
precision highp float;
precision highp sampler2D;
const vec2 POS[3] = vec2[3](
  vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0)
);
out vec2 vUv;
void main() {
  vec2 p = POS[gl_VertexID];
  vUv = 0.5 * (p + 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const lbmHelpers = `
float feq(float w, float rho, vec2 e, vec2 vel) {
  float eu = dot(e, vel);
  float uu = dot(vel, vel);
  return w * rho * (1.0 + 3.0 * eu + 4.5 * eu * eu - 1.5 * uu);
}

void equilibrium(float rho, vec2 vel, out vec4 a, out vec4 b, out vec4 c) {
  float f0 = feq(4.0/9.0, rho, vec2( 0.0, 0.0), vel);
  float f1 = feq(1.0/9.0, rho, vec2( 1.0, 0.0), vel);
  float f2 = feq(1.0/9.0, rho, vec2( 0.0, 1.0), vel);
  float f3 = feq(1.0/9.0, rho, vec2(-1.0, 0.0), vel);
  float f4 = feq(1.0/9.0, rho, vec2( 0.0,-1.0), vel);
  float f5 = feq(1.0/36.0, rho, vec2( 1.0, 1.0), vel);
  float f6 = feq(1.0/36.0, rho, vec2(-1.0, 1.0), vel);
  float f7 = feq(1.0/36.0, rho, vec2(-1.0,-1.0), vel);
  float f8 = feq(1.0/36.0, rho, vec2( 1.0,-1.0), vel);
  a = vec4(f0, f1, f2, f3);
  b = vec4(f4, f5, f6, f7);
  c = vec4(f8, 0.0, 0.0, 0.0);
}

void macros(vec4 a, vec4 b, vec4 c, out float rho, out vec2 vel) {
  float f0=a.x, f1=a.y, f2=a.z, f3=a.w;
  float f4=b.x, f5=b.y, f6=b.z, f7=b.w, f8=c.x;
  rho = max(0.30, f0+f1+f2+f3+f4+f5+f6+f7+f8);
  vel.x = (f1 - f3 + f5 - f6 - f7 + f8) / rho;
  vel.y = (f2 - f4 + f5 + f6 - f7 - f8) / rho;
}

void trtPair(
  in float fi, in float fj, in float ei, in float ej,
  in float omegaPlus, in float omegaMinus,
  out float oi, out float oj
) {
  float fp = 0.5 * (fi + fj);
  float fm = 0.5 * (fi - fj);
  float ep = 0.5 * (ei + ej);
  float em = 0.5 * (ei - ej);
  fp -= omegaPlus  * (fp - ep);
  fm -= omegaMinus * (fm - em);
  oi = fp + fm;
  oj = fp - fm;
}
`;

export const initLbmFragment = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform float uAmbient;
layout(location=0) out vec4 outA;
layout(location=1) out vec4 outB;
layout(location=2) out vec4 outC;
${lbmHelpers}
void main() {
  // A dynamically consistent initial condition: uniform ambient coflow.
  // The jet ramps smoothly from the uniform coflow; smoke is injected from
  // the first step instead of inventing a developed concentration field.
  equilibrium(1.0, vec2(uAmbient,0.0), outA,outB,outC);
}`;

export const lbmStepFragment = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uFA;
uniform sampler2D uFB;
uniform sampler2D uFC;
uniform float uTauPlus;
uniform float uTauMinus;
uniform float uAmbient;
uniform float uAmbientVy;
uniform float uJet;
uniform float uJetSigma;
uniform float uSourceY;
uniform float uCenterShift;
uniform float uJetSpeedFactor;
uniform vec4 uInletModes;
layout(location=0) out vec4 outA;
layout(location=1) out vec4 outB;
layout(location=2) out vec4 outC;
${lbmHelpers}

vec4 A(ivec2 p) { return texelFetch(uFA, p, 0); }
vec4 B(ivec2 p) { return texelFetch(uFB, p, 0); }
vec4 C(ivec2 p) { return texelFetch(uFC, p, 0); }

void main() {
  ivec2 sz = textureSize(uFA, 0);
  ivec2 q = ivec2(gl_FragCoord.xy);
  int x = q.x;
  int y = q.y;
  float yf = (float(y) + 0.5) / float(sz.y);

  if (x <= 1) {
    // Non-equilibrium extrapolation velocity inlet. Replacing every
    // distribution by equilibrium each step launches strong acoustic waves.
    // Here we impose the target macroscopic velocity while retaining the
    // non-equilibrium stress from the adjacent interior node.
    float centre = uSourceY + uCenterShift;
    float dy = (yf-centre)/max(uJetSigma,1e-4);
    float profile = exp(-0.5*dy*dy);
    float localJet = uAmbient + (uJet*uJetSpeedFactor-uAmbient)*profile;
    float sinuous = uInletModes.x * profile;
    float varicose = uInletModes.y * dy * profile;
    float higher = uInletModes.z * (dy*dy-1.0) * profile;
    float shearJitter = uInletModes.w * dy*(dy*dy-2.2)*profile;
    vec2 targetVel = vec2(localJet, uAmbientVy+sinuous+varicose+higher+shearJitter);
    float sp=length(targetVel);
    if(sp>0.145) targetVel*=0.145/sp;

    ivec2 pin=ivec2(min(3,sz.x-1),y);
    vec4 ia=A(pin), ib=B(pin), ic=C(pin);
    float rhoIn; vec2 velIn; macros(ia,ib,ic,rhoIn,velIn);
    vec4 eqIA,eqIB,eqIC, eqTA,eqTB,eqTC;
    equilibrium(rhoIn,velIn,eqIA,eqIB,eqIC);
    equilibrium(rhoIn,targetVel,eqTA,eqTB,eqTC);
    outA=eqTA+(ia-eqIA);
    outB=eqTB+(ib-eqIB);
    outC=eqTC+(ic-eqIC);
    return;
  }

  if (x >= sz.x-2) {
    ivec2 p=ivec2(sz.x-3,y);
    outA=A(p); outB=B(p); outC=C(p);
    return;
  }

  // Pull streaming with periodic cross-stream boundaries. The plume stays
  // far from y=0/1, so this is a cleaner approximation of an unbounded
  // cross-stream domain than repeatedly imposing equilibrium walls.
  int ym1=(y-1+sz.y)%sz.y;
  int yp1=(y+1)%sz.y;
  ivec2 p0=q;
  ivec2 p1=ivec2(x-1,y);
  ivec2 p2=ivec2(x,ym1);
  ivec2 p3=ivec2(x+1,y);
  ivec2 p4=ivec2(x,yp1);
  ivec2 p5=ivec2(x-1,ym1);
  ivec2 p6=ivec2(x+1,ym1);
  ivec2 p7=ivec2(x+1,yp1);
  ivec2 p8=ivec2(x-1,yp1);

  float f0=A(p0).x;
  float f1=A(p1).y;
  float f2=A(p2).z;
  float f3=A(p3).w;
  float f4=B(p4).x;
  float f5=B(p5).y;
  float f6=B(p6).z;
  float f7=B(p7).w;
  float f8=C(p8).x;

  vec4 a=vec4(f0,f1,f2,f3);
  vec4 b=vec4(f4,f5,f6,f7);
  vec4 c=vec4(f8,0.0,0.0,0.0);
  float rho; vec2 vel;
  macros(a,b,c,rho,vel);

  vec4 ea,eb,ec;
  equilibrium(rho,vel,ea,eb,ec);
  float op=1.0/uTauPlus;
  float om=1.0/uTauMinus;

  float g0=f0-op*(f0-ea.x);
  float g1,g3,g2,g4,g5,g7,g6,g8;
  trtPair(f1,f3,ea.y,ea.w,op,om,g1,g3);
  trtPair(f2,f4,ea.z,eb.x,op,om,g2,g4);
  trtPair(f5,f7,eb.y,eb.w,op,om,g5,g7);
  trtPair(f6,f8,eb.z,ec.x,op,om,g6,g8);
  a=vec4(g0,g1,g2,g3);
  b=vec4(g4,g5,g6,g7);
  c=vec4(g8,0.0,0.0,0.0);

  // Absorbing layers only near computational boundaries; there is no
  // domain-wide synthetic forcing.
  float spongeX=smoothstep(0.90,0.992,vUv.x);
  float sponge=0.018*spongeX;
  if (sponge>0.0) {
    vec4 sa,sb,sc;
    equilibrium(mix(rho,1.0,sponge),mix(vel,vec2(uAmbient,uAmbientVy),sponge),sa,sb,sc);
    a=mix(a,sa,sponge); b=mix(b,sb,sponge); c=mix(c,sc,sponge);
  }
  outA=a; outB=b; outC=c;
}`;

export const macroFragment = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uFA;
uniform sampler2D uFB;
uniform sampler2D uFC;
out vec4 outColor;
${lbmHelpers}
void main() {
  vec4 a=texture(uFA,vUv), b=texture(uFB,vUv), c=texture(uFC,vUv);
  float rho; vec2 vel; macros(a,b,c,rho,vel);
  outColor=vec4(vel,rho,1.0);
}`;

export const impulseFragment = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uFA;
uniform sampler2D uFB;
uniform sampler2D uFC;
uniform vec2 uPoint;
uniform vec2 uDeltaU;
uniform float uRadius;
uniform vec2 uAspect;
layout(location=0) out vec4 outA;
layout(location=1) out vec4 outB;
layout(location=2) out vec4 outC;
${lbmHelpers}
void main() {
  vec4 a=texture(uFA,vUv), b=texture(uFB,vUv), c=texture(uFC,vUv);
  float rho; vec2 vel; macros(a,b,c,rho,vel);
  vec2 d=(vUv-uPoint)*uAspect;
  float w=exp(-dot(d,d)/max(uRadius*uRadius,1e-7));
  vec2 newVel=vel+uDeltaU*w;
  float s=max(length(newVel),1e-8);
  if(s>0.155)newVel*=0.155/s;
  vec4 oldA,oldB,oldC,newA,newB,newC;
  equilibrium(rho,vel,oldA,oldB,oldC);
  equilibrium(rho,newVel,newA,newB,newC);
  outA=a+(newA-oldA); outB=b+(newB-oldB); outC=c+(newC-oldC);
}`;

export const clearScalarFragment = `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 outColor;
void main(){outColor=vec4(0.0);}`;

const scalarSampling = `
vec2 sampleScalarLinear(sampler2D tex, vec2 uv) {
  ivec2 sz=textureSize(tex,0);
  vec2 p=clamp(uv*vec2(sz)-0.5,vec2(0.0),vec2(sz)-1.0);
  ivec2 i0=ivec2(floor(p));
  vec2 f=fract(p);
  i0=clamp(i0,ivec2(0),sz-1);
  ivec2 i1=min(i0+ivec2(1),sz-1);
  vec2 a=texelFetch(tex,ivec2(i0.x,i0.y),0).xy;
  vec2 b=texelFetch(tex,ivec2(i1.x,i0.y),0).xy;
  vec2 c=texelFetch(tex,ivec2(i0.x,i1.y),0).xy;
  vec2 d=texelFetch(tex,ivec2(i1.x,i1.y),0).xy;
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
vec2 sampleVelocityLinear(sampler2D tex, vec2 uv) {
  ivec2 sz=textureSize(tex,0);
  vec2 p=clamp(uv*vec2(sz)-0.5,vec2(0.0),vec2(sz)-1.0);
  ivec2 i0=ivec2(floor(p));
  vec2 f=fract(p);
  i0=clamp(i0,ivec2(0),sz-1);
  ivec2 i1=min(i0+ivec2(1),sz-1);
  vec2 a=texelFetch(tex,ivec2(i0.x,i0.y),0).xy;
  vec2 b=texelFetch(tex,ivec2(i1.x,i0.y),0).xy;
  vec2 c=texelFetch(tex,ivec2(i0.x,i1.y),0).xy;
  vec2 d=texelFetch(tex,ivec2(i1.x,i1.y),0).xy;
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
`;

export const scalarAdvectFragment = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uScalar;
uniform sampler2D uVelocity;
uniform vec2 uTexelSize;
uniform float uStepScale;
uniform float uDissipation;
out vec4 outColor;
${scalarSampling}
void main(){
  vec2 vel=sampleVelocityLinear(uVelocity,vUv);
  vec2 departure=vUv-uStepScale*vel*uTexelSize;
  vec2 c=sampleScalarLinear(uScalar,departure)*uDissipation;
  outColor=vec4(max(c,0.0),0.0,1.0);
}`;

export const scalarCorrectFragment = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uOriginal;
uniform sampler2D uForward;
uniform sampler2D uBackward;
uniform sampler2D uVelocity;
uniform vec2 uTexelSize;
uniform float uStepScale;
uniform float uDissipation;
out vec4 outColor;
${scalarSampling}
void main(){
  vec2 original=texture(uOriginal,vUv).xy;
  vec2 forwardV=texture(uForward,vUv).xy;
  vec2 backwardV=texture(uBackward,vUv).xy;
  vec2 corrected=forwardV+0.5*(original-backwardV);

  vec2 vel=sampleVelocityLinear(uVelocity,vUv);
  vec2 dep=vUv-uStepScale*vel*uTexelSize;
  ivec2 sz=textureSize(uOriginal,0);
  vec2 p=clamp(dep*vec2(sz)-0.5,vec2(0.0),vec2(sz)-1.0);
  ivec2 i0=clamp(ivec2(floor(p)),ivec2(0),sz-1);
  ivec2 i1=min(i0+ivec2(1),sz-1);
  vec2 s0=texelFetch(uOriginal,ivec2(i0.x,i0.y),0).xy;
  vec2 s1=texelFetch(uOriginal,ivec2(i1.x,i0.y),0).xy;
  vec2 s2=texelFetch(uOriginal,ivec2(i0.x,i1.y),0).xy;
  vec2 s3=texelFetch(uOriginal,ivec2(i1.x,i1.y),0).xy;
  vec2 lo=min(min(s0,s1),min(s2,s3));
  vec2 hi=max(max(s0,s1),max(s2,s3));
  corrected=clamp(corrected,lo,hi)*uDissipation;
  outColor=vec4(max(corrected,0.0),0.0,1.0);
}`;

export const scalarDiffuseFragment = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uScalar;
uniform float uK;
out vec4 outColor;
void main(){
  ivec2 sz=textureSize(uScalar,0);
  ivec2 q=ivec2(gl_FragCoord.xy);
  ivec2 L=ivec2(max(q.x-1,0),q.y),R=ivec2(min(q.x+1,sz.x-1),q.y);
  ivec2 B=ivec2(q.x,max(q.y-1,0)),T=ivec2(q.x,min(q.y+1,sz.y-1));
  vec2 c=texelFetch(uScalar,q,0).xy;
  vec2 lap=texelFetch(uScalar,L,0).xy+texelFetch(uScalar,R,0).xy+texelFetch(uScalar,B,0).xy+texelFetch(uScalar,T,0).xy-4.0*c;
  outColor=vec4(max(vec2(0.0),c+uK*lap),0.0,1.0);
}`;

export const scalarSourceFragment = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uScalar;
uniform float uSourceY;
uniform float uCenterShift;
uniform float uSigmaY;
uniform float uSigmaX;
uniform float uLevel;
uniform float uX;
out vec4 outColor;
void main(){
  vec2 c=texture(uScalar,vUv).xy;
  float dx=(vUv.x-uX)/max(uSigmaX,1e-5);
  float dy=(vUv.y-(uSourceY+uCenterShift))/max(uSigmaY,1e-5);
  float profile=exp(-0.5*(dx*dx+dy*dy));
  c.x=max(c.x,uLevel*profile);
  outColor=vec4(c,0.0,1.0);
}`;

export const scalarSplatFragment = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uScalar;
uniform vec2 uPoint;
uniform float uRadius;
uniform float uAmount;
uniform vec2 uAspect;
out vec4 outColor;
void main(){
  vec2 c=texture(uScalar,vUv).xy;
  vec2 d=(vUv-uPoint)*uAspect;
  float w=exp(-dot(d,d)/max(uRadius*uRadius,1e-7));
  outColor=vec4(c.x,min(3.0,c.y+uAmount*w),0.0,1.0);
}`;

export const renderFragment = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uScalar;
uniform vec2 uTexelSize;
uniform float uOpacity;
uniform vec3 uTracerColor;
uniform float uThemeDark;
out vec4 outColor;
${scalarSampling}
void main(){
  vec2 concentrations=max(sampleScalarLinear(uScalar,vUv),vec2(0.0));
  float c=concentrations.x+concentrations.y;
  float L=texture(uScalar,vUv-vec2(uTexelSize.x,0.0)).x;
  float R=texture(uScalar,vUv+vec2(uTexelSize.x,0.0)).x;
  float B=texture(uScalar,vUv-vec2(0.0,uTexelSize.y)).x;
  float T=texture(uScalar,vUv+vec2(0.0,uTexelSize.y)).x;
  float grad=length(vec2(R-L,T-B));

  // Smoke transfer: suppress weak haze while retaining concentration sheets.
  float density=1.0-exp(-2.25*max(c-0.005,0.0));
  float detail=0.075*(1.0-exp(-10.0*grad));
  float intensity=clamp(pow(density,1.18)+detail,0.0,1.0);
  float alpha=clamp(intensity*uOpacity,0.0,0.91);
  float dense=clamp(intensity*0.95,0.0,1.0);
  vec3 smokeLight=mix(vec3(0.29),vec3(0.035),dense);
  vec3 smokeDark=mix(vec3(0.60),vec3(0.93),dense);
  vec3 smoke=mix(smokeLight,smokeDark,uThemeDark);
  float fraction=concentrations.y/max(c,1e-8);
  smoke=mix(smoke,uTracerColor,fraction);
  outColor=vec4(smoke*alpha,alpha);
}`;
