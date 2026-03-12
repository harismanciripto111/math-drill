'use strict';

(function () {
  function pointerPrototype() {
    this.id = -1;
    this.texcoordX = 0;
    this.texcoordY = 0;
    this.prevTexcoordX = 0;
    this.prevTexcoordY = 0;
    this.deltaX = 0;
    this.deltaY = 0;
    this.down = false;
    this.moved = false;
    this.color = [0, 0, 0];
  }

  var config = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: 1440,
    CAPTURE_RESOLUTION: 512,
    DENSITY_DISSIPATION: 3.5,
    VELOCITY_DISSIPATION: 2,
    PRESSURE: 0.1,
    PRESSURE_ITERATIONS: 20,
    CURL: 3,
    SPLAT_RADIUS: 0.2,
    SPLAT_FORCE: 6000,
    SHADING: true,
    COLOR_UPDATE_SPEED: 10,
    PAUSED: false,
    BACK_COLOR: { r: 0, g: 0, b: 0 },
    TRANSPARENT: true
  };

  var pointers = [new pointerPrototype()];
  var animFrameId = null;

  // Create canvas overlay
  var wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:fixed;top:0;left:0;z-index:9999;pointer-events:none;width:100%;height:100%;';
  var canvas = document.createElement('canvas');
  canvas.id = 'fluid-canvas';
  canvas.style.cssText = 'width:100vw;height:100vh;display:block;';
  wrapper.appendChild(canvas);
  document.body.appendChild(wrapper);

  var params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };
  var gl = canvas.getContext('webgl2', params);
  var isWebGL2 = !!gl;
  if (!isWebGL2) gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);

  var halfFloat, supportLinearFiltering;
  if (isWebGL2) {
    gl.getExtension('EXT_color_buffer_float');
    supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
  } else {
    halfFloat = gl.getExtension('OES_texture_half_float');
    supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
  }
  gl.clearColor(0.0, 0.0, 0.0, 1.0);
  var halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat && halfFloat.HALF_FLOAT_OES;

  if (!supportLinearFiltering) {
    config.DYE_RESOLUTION = 256;
    config.SHADING = false;
  }

  function getSupportedFormat(internalFormat, format, type) {
    if (!supportRenderTextureFormat(internalFormat, format, type)) {
      if (internalFormat === gl.R16F) return getSupportedFormat(gl.RG16F, gl.RG, type);
      if (internalFormat === gl.RG16F) return getSupportedFormat(gl.RGBA16F, gl.RGBA, type);
      return null;
    }
    return { internalFormat, format };
  }

  function supportRenderTextureFormat(internalFormat, format, type) {
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  }

  var formatRGBA, formatRG, formatR;
  if (isWebGL2) {
    formatRGBA = getSupportedFormat(gl.RGBA16F, gl.RGBA, halfFloatTexType);
    formatRG   = getSupportedFormat(gl.RG16F,   gl.RG,   halfFloatTexType);
    formatR    = getSupportedFormat(gl.R16F,    gl.RED,  halfFloatTexType);
  } else {
    formatRGBA = getSupportedFormat(gl.RGBA, gl.RGBA, halfFloatTexType);
    formatRG   = getSupportedFormat(gl.RGBA, gl.RGBA, halfFloatTexType);
    formatR    = getSupportedFormat(gl.RGBA, gl.RGBA, halfFloatTexType);
  }

  // ---- Shader compilation ----
  function compileShader(type, source, keywords) {
    if (keywords) {
      var kw = keywords.map(function(k){ return '#define ' + k; }).join('\n') + '\n';
      source = kw + source;
    }
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(shader));
    return shader;
  }

  function createProgram(vs, fs) {
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(prog));
    return prog;
  }

  function getUniforms(prog) {
    var u = {};
    var n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var name = gl.getActiveUniform(prog, i).name;
      u[name] = gl.getUniformLocation(prog, name);
    }
    return u;
  }

  var baseVS = compileShader(gl.VERTEX_SHADER, `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
    uniform vec2 texelSize;
    void main(){
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `);

  var copyFS       = compileShader(gl.FRAGMENT_SHADER, `precision mediump float; precision mediump sampler2D; varying highp vec2 vUv; uniform sampler2D uTexture; void main(){ gl_FragColor = texture2D(uTexture, vUv); }`);
  var clearFS      = compileShader(gl.FRAGMENT_SHADER, `precision mediump float; precision mediump sampler2D; varying highp vec2 vUv; uniform sampler2D uTexture; uniform float value; void main(){ gl_FragColor = value * texture2D(uTexture, vUv); }`);
  var splatFS      = compileShader(gl.FRAGMENT_SHADER, `precision highp float; precision highp sampler2D; varying vec2 vUv; uniform sampler2D uTarget; uniform float aspectRatio; uniform vec3 color; uniform vec2 point; uniform float radius; void main(){ vec2 p = vUv - point.xy; p.x *= aspectRatio; vec3 splat = exp(-dot(p,p)/radius)*color; vec3 base = texture2D(uTarget, vUv).xyz; gl_FragColor = vec4(base+splat, 1.0); }`);
  var divergenceFS = compileShader(gl.FRAGMENT_SHADER, `precision mediump float; precision mediump sampler2D; varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB; uniform sampler2D uVelocity; void main(){ float L=texture2D(uVelocity,vL).x; float R=texture2D(uVelocity,vR).x; float T=texture2D(uVelocity,vT).y; float B=texture2D(uVelocity,vB).y; vec2 C=texture2D(uVelocity,vUv).xy; if(vL.x<0.0){L=-C.x;} if(vR.x>1.0){R=-C.x;} if(vT.y>1.0){T=-C.y;} if(vB.y<0.0){B=-C.y;} gl_FragColor=vec4(0.5*(R-L+T-B),0,0,1); }`);
  var curlFS       = compileShader(gl.FRAGMENT_SHADER, `precision mediump float; precision mediump sampler2D; varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB; uniform sampler2D uVelocity; void main(){ float L=texture2D(uVelocity,vL).y; float R=texture2D(uVelocity,vR).y; float T=texture2D(uVelocity,vT).x; float B=texture2D(uVelocity,vB).x; gl_FragColor=vec4(0.5*(R-L-T+B),0,0,1); }`);
  var vorticityFS  = compileShader(gl.FRAGMENT_SHADER, `precision highp float; precision highp sampler2D; varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB; uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float curl; uniform float dt; void main(){ float L=texture2D(uCurl,vL).x; float R=texture2D(uCurl,vR).x; float T=texture2D(uCurl,vT).x; float B=texture2D(uCurl,vB).x; float C=texture2D(uCurl,vUv).x; vec2 force=0.5*vec2(abs(T)-abs(B),abs(R)-abs(L)); force/=length(force)+0.0001; force*=curl*C; force.y*=-1.0; vec2 vel=texture2D(uVelocity,vUv).xy; vel+=force*dt; vel=min(max(vel,-1000.0),1000.0); gl_FragColor=vec4(vel,0,1); }`);
  var pressureFS   = compileShader(gl.FRAGMENT_SHADER, `precision mediump float; precision mediump sampler2D; varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB; uniform sampler2D uPressure; uniform sampler2D uDivergence; void main(){ float L=texture2D(uPressure,vL).x; float R=texture2D(uPressure,vR).x; float T=texture2D(uPressure,vT).x; float B=texture2D(uPressure,vB).x; float div=texture2D(uDivergence,vUv).x; gl_FragColor=vec4((L+R+B+T-div)*0.25,0,0,1); }`);
  var gradSubFS    = compileShader(gl.FRAGMENT_SHADER, `precision mediump float; precision mediump sampler2D; varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB; uniform sampler2D uPressure; uniform sampler2D uVelocity; void main(){ float L=texture2D(uPressure,vL).x; float R=texture2D(uPressure,vR).x; float T=texture2D(uPressure,vT).x; float B=texture2D(uPressure,vB).x; vec2 vel=texture2D(uVelocity,vUv).xy; vel.xy-=vec2(R-L,T-B); gl_FragColor=vec4(vel,0,1); }`);

  var displayFSSource = `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
    uniform sampler2D uTexture; uniform vec2 texelSize;
    vec3 linearToGamma(vec3 c){ c=max(c,vec3(0)); return max(1.055*pow(c,vec3(0.416666667))-0.055,vec3(0)); }
    void main(){
      vec3 c = texture2D(uTexture, vUv).rgb;
      #ifdef SHADING
        vec3 lc=texture2D(uTexture,vL).rgb; vec3 rc=texture2D(uTexture,vR).rgb;
        vec3 tc=texture2D(uTexture,vT).rgb; vec3 bc=texture2D(uTexture,vB).rgb;
        float dx=length(rc)-length(lc); float dy=length(tc)-length(bc);
        vec3 n=normalize(vec3(dx,dy,length(texelSize))); vec3 l=vec3(0,0,1);
        float diffuse=clamp(dot(n,l)+0.7,0.7,1.0); c*=diffuse;
      #endif
      float a=max(c.r,max(c.g,c.b)); gl_FragColor=vec4(c,a);
    }
  `;

  var advectionFSSource = `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv; uniform sampler2D uVelocity; uniform sampler2D uSource;
    uniform vec2 texelSize; uniform vec2 dyeTexelSize; uniform float dt; uniform float dissipation;
    vec4 bilerp(sampler2D sam, vec2 uv, vec2 tsize){
      vec2 st=uv/tsize-0.5; vec2 iuv=floor(st); vec2 fuv=fract(st);
      vec4 a=texture2D(sam,(iuv+vec2(0.5,0.5))*tsize); vec4 b=texture2D(sam,(iuv+vec2(1.5,0.5))*tsize);
      vec4 c=texture2D(sam,(iuv+vec2(0.5,1.5))*tsize); vec4 d=texture2D(sam,(iuv+vec2(1.5,1.5))*tsize);
      return mix(mix(a,b,fuv.x),mix(c,d,fuv.x),fuv.y);
    }
    void main(){
      #ifdef MANUAL_FILTERING
        vec2 coord=vUv-dt*bilerp(uVelocity,vUv,texelSize).xy*texelSize;
        vec4 result=bilerp(uSource,coord,dyeTexelSize);
      #else
        vec2 coord=vUv-dt*texture2D(uVelocity,vUv).xy*texelSize;
        vec4 result=texture2D(uSource,coord);
      #endif
      float decay=1.0+dissipation*dt; gl_FragColor=result/decay;
    }
  `;

  // Programs
  function makeProgram(fs) {
    var p = createProgram(baseVS, fs);
    return { program: p, uniforms: getUniforms(p), bind: function(){ gl.useProgram(p); } };
  }

  var copyProg      = makeProgram(copyFS);
  var clearProg     = makeProgram(clearFS);
  var splatProg     = makeProgram(splatFS);
  var divProg       = makeProgram(divergenceFS);
  var curlProg      = makeProgram(curlFS);
  var vortProg      = makeProgram(vorticityFS);
  var pressureProg  = makeProgram(pressureFS);
  var gradSubProg   = makeProgram(gradSubFS);

  var advectionKeywords = supportLinearFiltering ? null : ['MANUAL_FILTERING'];
  var advectionFS   = compileShader(gl.FRAGMENT_SHADER, advectionFSSource, advectionKeywords);
  var advectionProg = makeProgram(advectionFS);

  var displayKeywords = config.SHADING ? ['SHADING'] : [];
  var displayFS     = compileShader(gl.FRAGMENT_SHADER, displayFSSource, displayKeywords);
  var displayProg   = makeProgram(displayFS);

  // Blit
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,-1,1,1,1,1,-1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2,0,2,3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);

  function blit(target, clear) {
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    if (clear) { gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  // FBOs
  var dye, velocity, divergence, curlFBO, pressure;

  function createFBO(w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h); gl.clear(gl.COLOR_BUFFER_BIT);
    var tsx = 1.0/w, tsy = 1.0/h;
    return { texture:tex, fbo:fbo, width:w, height:h, texelSizeX:tsx, texelSizeY:tsy,
      attach: function(id){ gl.activeTexture(gl.TEXTURE0+id); gl.bindTexture(gl.TEXTURE_2D, tex); return id; }
    };
  }

  function createDoubleFBO(w, h, internalFormat, format, type, param) {
    var fbo1 = createFBO(w, h, internalFormat, format, type, param);
    var fbo2 = createFBO(w, h, internalFormat, format, type, param);
    return {
      width:w, height:h, texelSizeX:fbo1.texelSizeX, texelSizeY:fbo1.texelSizeY,
      get read(){ return fbo1; }, set read(v){ fbo1=v; },
      get write(){ return fbo2; }, set write(v){ fbo2=v; },
      swap: function(){ var t=fbo1; fbo1=fbo2; fbo2=t; }
    };
  }

  function resizeFBO(target, w, h, internalFormat, format, type, param) {
    var nf = createFBO(w, h, internalFormat, format, type, param);
    copyProg.bind();
    gl.uniform1i(copyProg.uniforms.uTexture, target.attach(0));
    blit(nf); return nf;
  }

  function resizeDoubleFBO(target, w, h, internalFormat, format, type, param) {
    if (target.width===w && target.height===h) return target;
    target.read  = resizeFBO(target.read,  w, h, internalFormat, format, type, param);
    target.write = createFBO(w, h, internalFormat, format, type, param);
    target.width=w; target.height=h;
    target.texelSizeX=1.0/w; target.texelSizeY=1.0/h;
    return target;
  }

  function getResolution(resolution) {
    var ar = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (ar < 1) ar = 1.0/ar;
    var min = Math.round(resolution), max = Math.round(resolution*ar);
    return gl.drawingBufferWidth > gl.drawingBufferHeight ? {width:max,height:min} : {width:min,height:max};
  }

  function initFramebuffers() {
    var simRes = getResolution(config.SIM_RESOLUTION);
    var dyeRes = getResolution(config.DYE_RESOLUTION);
    var texType = halfFloatTexType;
    var rgba = formatRGBA, rg = formatRG, r = formatR;
    var filtering = supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
    gl.disable(gl.BLEND);
    if (!dye)      dye      = createDoubleFBO(dyeRes.width,  dyeRes.height,  rgba.internalFormat, rgba.format, texType, filtering);
    else           dye      = resizeDoubleFBO(dye,  dyeRes.width,  dyeRes.height,  rgba.internalFormat, rgba.format, texType, filtering);
    if (!velocity) velocity = createDoubleFBO(simRes.width, simRes.height, rg.internalFormat,   rg.format,   texType, filtering);
    else           velocity = resizeDoubleFBO(velocity, simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
    divergence = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    curlFBO    = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    pressure   = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
  }

  initFramebuffers();

  // ---- Helpers ----
  function scaleByPixelRatio(v){ return Math.floor(v * (window.devicePixelRatio||1)); }

  function generateColor(){
    var c = HSVtoRGB(Math.random(), 1.0, 1.0);
    c.r *= 0.15; c.g *= 0.15; c.b *= 0.15;
    return c;
  }

  function HSVtoRGB(h, s, v){
    var r,g,b,i,f,p,q,t;
    i=Math.floor(h*6); f=h*6-i; p=v*(1-s); q=v*(1-f*s); t=v*(1-(1-f)*s);
    switch(i%6){
      case 0: r=v;g=t;b=p; break; case 1: r=q;g=v;b=p; break;
      case 2: r=p;g=v;b=t; break; case 3: r=p;g=q;b=v; break;
      case 4: r=t;g=p;b=v; break; case 5: r=v;g=p;b=q; break;
    }
    return {r,g,b};
  }

  function correctRadius(radius){ var ar=canvas.width/canvas.height; if(ar>1) radius*=ar; return radius; }
  function correctDeltaX(d){ var ar=canvas.width/canvas.height; if(ar<1) d*=ar; return d; }
  function correctDeltaY(d){ var ar=canvas.width/canvas.height; if(ar>1) d/=ar; return d; }

  function updatePointerDownData(pointer, id, posX, posY){
    pointer.id=id; pointer.down=true; pointer.moved=false;
    pointer.texcoordX=posX/canvas.width; pointer.texcoordY=1.0-posY/canvas.height;
    pointer.prevTexcoordX=pointer.texcoordX; pointer.prevTexcoordY=pointer.texcoordY;
    pointer.deltaX=0; pointer.deltaY=0; pointer.color=generateColor();
  }

  function updatePointerMoveData(pointer, posX, posY, color){
    pointer.prevTexcoordX=pointer.texcoordX; pointer.prevTexcoordY=pointer.texcoordY;
    pointer.texcoordX=posX/canvas.width; pointer.texcoordY=1.0-posY/canvas.height;
    pointer.deltaX=correctDeltaX(pointer.texcoordX-pointer.prevTexcoordX);
    pointer.deltaY=correctDeltaY(pointer.texcoordY-pointer.prevTexcoordY);
    pointer.moved=Math.abs(pointer.deltaX)>0||Math.abs(pointer.deltaY)>0;
    pointer.color=color;
  }

  function updatePointerUpData(pointer){ pointer.down=false; }

  function splat(x, y, dx, dy, color){
    splatProg.bind();
    gl.uniform1i(splatProg.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatProg.uniforms.aspectRatio, canvas.width/canvas.height);
    gl.uniform2f(splatProg.uniforms.point, x, y);
    gl.uniform3f(splatProg.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(splatProg.uniforms.radius, correctRadius(config.SPLAT_RADIUS/100.0));
    blit(velocity.write); velocity.swap();
    gl.uniform1i(splatProg.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(splatProg.uniforms.color, color.r, color.g, color.b);
    blit(dye.write); dye.swap();
  }

  function splatPointer(p){ splat(p.texcoordX, p.texcoordY, p.deltaX*config.SPLAT_FORCE, p.deltaY*config.SPLAT_FORCE, p.color); }

  function clickSplat(p){
    var color=generateColor(); color.r*=10; color.g*=10; color.b*=10;
    splat(p.texcoordX, p.texcoordY, 10*(Math.random()-0.5), 30*(Math.random()-0.5), color);
  }

  function step(dt){
    gl.disable(gl.BLEND);
    curlProg.bind();
    gl.uniform2f(curlProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProg.uniforms.uVelocity, velocity.read.attach(0));
    blit(curlFBO);
    vortProg.bind();
    gl.uniform2f(vortProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vortProg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vortProg.uniforms.uCurl, curlFBO.attach(1));
    gl.uniform1f(vortProg.uniforms.curl, config.CURL);
    gl.uniform1f(vortProg.uniforms.dt, dt);
    blit(velocity.write); velocity.swap();
    divProg.bind();
    gl.uniform2f(divProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divProg.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);
    clearProg.bind();
    gl.uniform1i(clearProg.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProg.uniforms.value, config.PRESSURE);
    blit(pressure.write); pressure.swap();
    pressureProg.bind();
    gl.uniform2f(pressureProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureProg.uniforms.uDivergence, divergence.attach(0));
    for (var i=0; i<config.PRESSURE_ITERATIONS; i++){
      gl.uniform1i(pressureProg.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write); pressure.swap();
    }
    gradSubProg.bind();
    gl.uniform2f(gradSubProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradSubProg.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradSubProg.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write); velocity.swap();
    advectionProg.bind();
    gl.uniform2f(advectionProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    if (!supportLinearFiltering) gl.uniform2f(advectionProg.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    var velId = velocity.read.attach(0);
    gl.uniform1i(advectionProg.uniforms.uVelocity, velId);
    gl.uniform1i(advectionProg.uniforms.uSource, velId);
    gl.uniform1f(advectionProg.uniforms.dt, dt);
    gl.uniform1f(advectionProg.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity.write); velocity.swap();
    if (!supportLinearFiltering) gl.uniform2f(advectionProg.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(advectionProg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProg.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advectionProg.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(dye.write); dye.swap();
  }

  function render(){
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
    var w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    displayProg.bind();
    if (config.SHADING) gl.uniform2f(displayProg.uniforms.texelSize, 1.0/w, 1.0/h);
    gl.uniform1i(displayProg.uniforms.uTexture, dye.read.attach(0));
    blit(null);
  }

  // ---- Main loop ----
  var lastUpdateTime = Date.now();
  var colorUpdateTimer = 0;

  function resizeCanvas(){
    var w = scaleByPixelRatio(canvas.clientWidth);
    var h = scaleByPixelRatio(canvas.clientHeight);
    if (canvas.width!==w || canvas.height!==h){ canvas.width=w; canvas.height=h; return true; }
    return false;
  }

  function updateFrame(){
    var now = Date.now();
    var dt = Math.min((now-lastUpdateTime)/1000, 0.016666);
    lastUpdateTime = now;
    if (resizeCanvas()) initFramebuffers();
    colorUpdateTimer += dt * config.COLOR_UPDATE_SPEED;
    if (colorUpdateTimer >= 1){
      colorUpdateTimer = colorUpdateTimer % 1;
      pointers.forEach(function(p){ p.color = generateColor(); });
    }
    pointers.forEach(function(p){ if(p.moved){ p.moved=false; splatPointer(p); } });
    step(dt);
    render();
    animFrameId = requestAnimationFrame(updateFrame);
  }

  updateFrame();

  // ---- Events ----
  window.addEventListener('mousedown', function(e){
    var p = pointers[0];
    updatePointerDownData(p, -1, scaleByPixelRatio(e.clientX), scaleByPixelRatio(e.clientY));
    clickSplat(p);
  });

  var firstMove = false;
  window.addEventListener('mousemove', function(e){
    var p = pointers[0];
    var posX = scaleByPixelRatio(e.clientX);
    var posY = scaleByPixelRatio(e.clientY);
    if (!firstMove){ updatePointerMoveData(p, posX, posY, generateColor()); firstMove=true; }
    else { updatePointerMoveData(p, posX, posY, p.color); }
  });

  window.addEventListener('touchstart', function(e){
    var touches = e.targetTouches, p = pointers[0];
    for (var i=0; i<touches.length; i++)
      updatePointerDownData(p, touches[i].identifier, scaleByPixelRatio(touches[i].clientX), scaleByPixelRatio(touches[i].clientY));
  });

  window.addEventListener('touchmove', function(e){
    var touches = e.targetTouches, p = pointers[0];
    for (var i=0; i<touches.length; i++)
      updatePointerMoveData(p, scaleByPixelRatio(touches[i].clientX), scaleByPixelRatio(touches[i].clientY), p.color);
  }, false);

  window.addEventListener('touchend', function(e){
    var touches = e.changedTouches, p = pointers[0];
    for (var i=0; i<touches.length; i++) updatePointerUpData(p);
  });
})();
