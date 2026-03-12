(function() {
  // Create canvas FIRST and append to body BEFORE anything else
  var canvas = document.createElement('canvas');
  canvas.id = 'splash-canvas';
  // Inline styles take priority over everything
  canvas.setAttribute('style', [
    'position:fixed',
    'top:0',
    'left:0',
    'width:100%',
    'height:100%',
    'z-index:0',
    'pointer-events:none',
    'display:block'
  ].join(';') + ';');
  document.body.insertBefore(canvas, document.body.firstChild);

  var config = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: 1024,
    CAPTURE_RESOLUTION: 512,
    DENSITY_DISSIPATION: 1,
    VELOCITY_DISSIPATION: 0.2,
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: 20,
    CURL: 30,
    SPLAT_RADIUS: 0.25,
    SPLAT_FORCE: 6000,
    SHADING: true,
    COLOR_UPDATE_SPEED: 10,
    PAUSED: false,
    BACK_COLOR: { r: 0, g: 0, b: 0 },
    TRANSPARENT: true
  };

  var pointers = [];
  var splatStack = [];

  var Pointer = function() {
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
  };

  pointers.push(new Pointer());

  function getWebGLContext(canvas) {
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
    gl.clearColor(0, 0, 0, 0);
    var halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : (halfFloat ? halfFloat.HALF_FLOAT_OES : gl.UNSIGNED_BYTE);
    var formatRGBA, formatRG, formatR;
    if (isWebGL2) {
      formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
      formatRG   = getSupportedFormat(gl, gl.RG16F,   gl.RG,   halfFloatTexType);
      formatR    = getSupportedFormat(gl, gl.R16F,    gl.RED,  halfFloatTexType);
    } else {
      formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      formatRG   = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      formatR    = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    }
    return { gl, ext: { formatRGBA, formatRG, formatR, halfFloatTexType, supportLinearFiltering } };
  }

  function getSupportedFormat(gl, internalFormat, format, type) {
    if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
      switch (internalFormat) {
        case gl.R16F:    return getSupportedFormat(gl, gl.RG16F,   gl.RG,   type);
        case gl.RG16F:   return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
        default:         return null;
      }
    }
    return { internalFormat, format };
  }

  function supportRenderTextureFormat(gl, internalFormat, format, type) {
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

  var _getWebGLContext = getWebGLContext(canvas);
  var gl  = _getWebGLContext.gl;
  var ext = _getWebGLContext.ext;

  if (!gl) return; // no WebGL support, bail silently

  // ---- SHADERS ----
  var baseVertexShaderSrc = `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform vec2 texelSize;
    void main () {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }`;

  var copyShaderSrc = `
    precision mediump float;
    precision mediump sampler2D;
    varying highp vec2 vUv;
    uniform sampler2D uTexture;
    void main () { gl_FragColor = texture2D(uTexture, vUv); }`;

  var clearShaderSrc = `
    precision mediump float;
    precision mediump sampler2D;
    varying highp vec2 vUv;
    uniform sampler2D uTexture;
    uniform float value;
    void main () { gl_FragColor = value * texture2D(uTexture, vUv); }`;

  var displayShaderSrc = `
    precision highp float;
    precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTexture;
    void main () {
      vec3 C = texture2D(uTexture, vUv).rgb;
      float a = max(C.r, max(C.g, C.b));
      gl_FragColor = vec4(C, a);
    }`;

  var splatShaderSrc = `
    precision highp float;
    precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform float aspectRatio;
    uniform vec3 color;
    uniform vec2 point;
    uniform float radius;
    void main () {
      vec2 p = vUv - point.xy;
      p.x *= aspectRatio;
      vec3 splat = exp(-dot(p, p) / radius) * color;
      vec3 base  = texture2D(uTarget, vUv).xyz;
      gl_FragColor = vec4(base + splat, 1.0);
    }`;

  var advectionShaderSrc = `
    precision highp float;
    precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 texelSize;
    uniform vec2 dyeTexelSize;
    uniform float dt;
    uniform float dissipation;
    void main () {
      vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
      gl_FragColor = dissipation * texture2D(uSource, coord);
      gl_FragColor.a = 1.0;
    }`;

  var divergenceShaderSrc = `
    precision mediump float;
    precision mediump sampler2D;
    varying highp vec2 vUv;
    varying highp vec2 vL; varying highp vec2 vR;
    varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).x;
      float R = texture2D(uVelocity, vR).x;
      float T = texture2D(uVelocity, vT).y;
      float B = texture2D(uVelocity, vB).y;
      float div = 0.5 * (R - L + T - B);
      gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
    }`;

  var curlShaderSrc = `
    precision mediump float;
    precision mediump sampler2D;
    varying highp vec2 vUv;
    varying highp vec2 vL; varying highp vec2 vR;
    varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).y;
      float R = texture2D(uVelocity, vR).y;
      float T = texture2D(uVelocity, vT).x;
      float B = texture2D(uVelocity, vB).x;
      gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
    }`;

  var vorticityShaderSrc = `
    precision highp float;
    precision highp sampler2D;
    varying vec2 vUv;
    varying vec2 vL; varying vec2 vR;
    varying vec2 vT; varying vec2 vB;
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform float curl;
    uniform float dt;
    void main () {
      float L = texture2D(uCurl, vL).x;
      float R = texture2D(uCurl, vR).x;
      float T = texture2D(uCurl, vT).x;
      float B = texture2D(uCurl, vB).x;
      float C = texture2D(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force /= length(force) + 0.0001;
      force *= curl * C;
      force.y *= -1.0;
      vec2 vel = texture2D(uVelocity, vUv).xy;
      gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);
    }`;

  var pressureShaderSrc = `
    precision mediump float;
    precision mediump sampler2D;
    varying highp vec2 vUv;
    varying highp vec2 vL; varying highp vec2 vR;
    varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;
    void main () {
      float L = texture2D(uPressure, vL).x;
      float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x;
      float B = texture2D(uPressure, vB).x;
      float C = texture2D(uPressure, vUv).x;
      float divergence = texture2D(uDivergence, vUv).x;
      float pressure = (L + R + B + T - divergence) * 0.25;
      gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
    }`;

  var gradientSubtractShaderSrc = `
    precision mediump float;
    precision mediump sampler2D;
    varying highp vec2 vUv;
    varying highp vec2 vL; varying highp vec2 vR;
    varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uPressure, vL).x;
      float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x;
      float B = texture2D(uPressure, vB).x;
      vec2 velocity = texture2D(uVelocity, vUv).xy;
      velocity.xy -= vec2(R - L, T - B);
      gl_FragColor = vec4(velocity, 0.0, 1.0);
    }`;

  function compileShader(type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  }

  function createProgram(vertSrc, fragSrc) {
    var prog = gl.createProgram();
    gl.attachShader(prog, compileShader(gl.VERTEX_SHADER, vertSrc));
    gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(prog);
    var uniforms = {};
    var n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(prog, i);
      uniforms[info.name] = gl.getUniformLocation(prog, info.name);
    }
    return { program: prog, uniforms };
  }

  var programs = {
    copy:             createProgram(baseVertexShaderSrc, copyShaderSrc),
    clear:            createProgram(baseVertexShaderSrc, clearShaderSrc),
    display:          createProgram(baseVertexShaderSrc, displayShaderSrc),
    splat:            createProgram(baseVertexShaderSrc, splatShaderSrc),
    advection:        createProgram(baseVertexShaderSrc, advectionShaderSrc),
    divergence:       createProgram(baseVertexShaderSrc, divergenceShaderSrc),
    curl:             createProgram(baseVertexShaderSrc, curlShaderSrc),
    vorticity:        createProgram(baseVertexShaderSrc, vorticityShaderSrc),
    pressure:         createProgram(baseVertexShaderSrc, pressureShaderSrc),
    gradientSubtract: createProgram(baseVertexShaderSrc, gradientSubtractShaderSrc),
  };

  var blit = (function() {
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,-1,1,1,1,1,-1]), gl.STATIC_DRAW);
    var ibuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2,0,2,3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
    return function(target) {
      if (target == null) {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } else {
        gl.viewport(0, 0, target.width, target.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    };
  })();

  function createFBO(w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    var texelSizeX = 1.0 / w, texelSizeY = 1.0 / h;
    return { texture, fbo, width: w, height: h, texelSizeX, texelSizeY,
      attach: function(id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; }
    };
  }

  function createDoubleFBO(w, h, internalFormat, format, type, param) {
    var fbo1 = createFBO(w, h, internalFormat, format, type, param);
    var fbo2 = createFBO(w, h, internalFormat, format, type, param);
    return {
      width: w, height: h, texelSizeX: fbo1.texelSizeX, texelSizeY: fbo1.texelSizeY,
      get read() { return fbo1; }, set read(v) { fbo1 = v; },
      get write() { return fbo2; }, set write(v) { fbo2 = v; },
      swap: function() { var tmp = fbo1; fbo1 = fbo2; fbo2 = tmp; }
    };
  }

  function getResolution(res) {
    var w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    if (w > h) { var r = w/h; return { width: Math.round(res*r), height: res }; }
    else        { var r = h/w; return { width: res, height: Math.round(res*r) }; }
  }

  function resizeCanvas() {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; return true; }
    return false;
  }

  var simWidth, simHeight, dyeWidth, dyeHeight;
  var density, velocity, divergence, curl, pressure;

  function initFBOs() {
    gl.disable(gl.BLEND);
    var simRes = getResolution(config.SIM_RESOLUTION);
    var dyeRes = getResolution(config.DYE_RESOLUTION);
    simWidth = simRes.width; simHeight = simRes.height;
    dyeWidth = dyeRes.width; dyeHeight = dyeRes.height;
    var texType   = ext.halfFloatTexType;
    var rgba      = ext.formatRGBA;
    var rg        = ext.formatRG;
    var r         = ext.formatR;
    var filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
    if (!density)   density   = createDoubleFBO(dyeWidth,  dyeHeight,  rgba.internalFormat, rgba.format, texType, filtering);
    else            density   = resizeDoubleFBO(density,   dyeWidth,  dyeHeight,  rgba.internalFormat, rgba.format, texType, filtering);
    if (!velocity)  velocity  = createDoubleFBO(simWidth,  simHeight,  rg.internalFormat,   rg.format,   texType, filtering);
    else            velocity  = resizeDoubleFBO(velocity,  simWidth,  simHeight,  rg.internalFormat,   rg.format,   texType, filtering);
    divergence = createFBO(simWidth, simHeight, r.internalFormat, r.format, texType, gl.NEAREST);
    curl       = createFBO(simWidth, simHeight, r.internalFormat, r.format, texType, gl.NEAREST);
    pressure   = createDoubleFBO(simWidth, simHeight, r.internalFormat, r.format, texType, gl.NEAREST);
  }

  function resizeDoubleFBO(target, w, h, internalFormat, format, type, param) {
    if (target.width === w && target.height === h) return target;
    target.read  = resizeFBO(target.read,  w, h, internalFormat, format, type, param);
    target.write = createFBO(w, h, internalFormat, format, type, param);
    target.width = w; target.height = h;
    target.texelSizeX = 1.0/w; target.texelSizeY = 1.0/h;
    return target;
  }

  function resizeFBO(target, w, h, internalFormat, format, type, param) {
    var newFBO = createFBO(w, h, internalFormat, format, type, param);
    var p = programs.copy;
    gl.useProgram(p.program);
    gl.uniform1i(p.uniforms.uTexture, target.attach(0));
    blit(newFBO);
    return newFBO;
  }

  resizeCanvas();
  initFBOs();

  function HSVtoRGB(h, s, v) {
    var i = Math.floor(h*6), f = h*6-i, p = v*(1-s), q = v*(1-f*s), t = v*(1-(1-f)*s);
    switch(i%6) {
      case 0: return {r:v,g:t,b:p}; case 1: return {r:q,g:v,b:p};
      case 2: return {r:p,g:v,b:t}; case 3: return {r:p,g:q,b:v};
      case 4: return {r:t,g:p,b:v}; case 5: return {r:v,g:p,b:q};
    }
  }

  function generateColor() {
    var c = HSVtoRGB(Math.random(), 1.0, 1.0);
    return [c.r * 0.15, c.g * 0.15, c.b * 0.15];
  }

  function correctDeltaX(delta) { return canvas.width > canvas.height ? delta * (canvas.height/canvas.width) : delta; }
  function correctDeltaY(delta) { return canvas.width > canvas.height ? delta : delta * (canvas.width/canvas.height); }

  function splat(x, y, dx, dy, color) {
    gl.useProgram(programs.splat.program);
    gl.uniform1i(programs.splat.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(programs.splat.uniforms.aspectRatio, canvas.width/canvas.height);
    gl.uniform2f(programs.splat.uniforms.point, x, y);
    gl.uniform3f(programs.splat.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(programs.splat.uniforms.radius, correctRadius(config.SPLAT_RADIUS/100.0));
    blit(velocity.write);
    velocity.swap();
    gl.uniform1i(programs.splat.uniforms.uTarget, density.read.attach(0));
    gl.uniform3f(programs.splat.uniforms.color, color[0], color[1], color[2]);
    blit(density.write);
    density.swap();
  }

  function correctRadius(r) {
    var ar = canvas.width / canvas.height;
    return ar > 1 ? r * ar : r;
  }

  function multipleSplats(amount) {
    for (var i = 0; i < amount; i++) {
      var color = generateColor();
      color[0] *= 10; color[1] *= 10; color[2] *= 10;
      var x = Math.random(), y = Math.random();
      var dx = 1000*(Math.random()*2-1), dy = 1000*(Math.random()*2-1);
      splat(x, y, dx, dy, color);
    }
  }

  function updatePointerDownData(ptr, id, posX, posY) {
    ptr.id = id;
    ptr.down = true;
    ptr.moved = false;
    ptr.texcoordX = posX / canvas.width;
    ptr.texcoordY = 1.0 - posY / canvas.height;
    ptr.prevTexcoordX = ptr.texcoordX;
    ptr.prevTexcoordY = ptr.texcoordY;
    ptr.deltaX = 0; ptr.deltaY = 0;
    ptr.color = generateColor();
  }

  function updatePointerMoveData(ptr, posX, posY) {
    ptr.prevTexcoordX = ptr.texcoordX;
    ptr.prevTexcoordY = ptr.texcoordY;
    ptr.texcoordX = posX / canvas.width;
    ptr.texcoordY = 1.0 - posY / canvas.height;
    ptr.deltaX = correctDeltaX(ptr.texcoordX - ptr.prevTexcoordX);
    ptr.deltaY = correctDeltaY(ptr.texcoordY - ptr.prevTexcoordY);
    ptr.moved = Math.abs(ptr.deltaX) > 0 || Math.abs(ptr.deltaY) > 0;
  }

  function updatePointerUpData(ptr) { ptr.down = false; }

  // pointer-events: none is set via inline style, so these listeners are just for
  // reading mouse position -- they will NOT block clicks on elements above the canvas
  window.addEventListener('mousemove', function(e) {
    var p = pointers[0];
    if (!p.down) p.color = generateColor();
    p.down = true;
    updatePointerMoveData(p, e.clientX, e.clientY);
  });
  window.addEventListener('mousedown', function(e) {
    updatePointerDownData(pointers[0], -1, e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', function() { updatePointerUpData(pointers[0]); });
  window.addEventListener('touchstart', function(e) {
    var touches = e.targetTouches;
    while (pointers.length <= touches.length) pointers.push(new Pointer());
    for (var i = 0; i < touches.length; i++) {
      updatePointerDownData(pointers[i+1], touches[i].identifier, touches[i].clientX, touches[i].clientY);
    }
  }, { passive: true });
  window.addEventListener('touchmove', function(e) {
    var touches = e.targetTouches;
    for (var i = 0; i < touches.length; i++) {
      updatePointerMoveData(pointers[i+1], touches[i].clientX, touches[i].clientY);
    }
  }, { passive: true });
  window.addEventListener('touchend', function(e) {
    var touches = e.changedTouches;
    for (var i = 0; i < touches.length; i++) {
      for (var j = 0; j < pointers.length; j++) {
        if (pointers[j].id === touches[i].identifier) updatePointerUpData(pointers[j]);
      }
    }
  });

  var lastTime = Date.now();

  function step(dt) {
    gl.disable(gl.BLEND);
    var simTexelSize = { x: 1.0/simWidth, y: 1.0/simHeight };

    // curl
    gl.useProgram(programs.curl.program);
    gl.uniform2f(programs.curl.uniforms.texelSize, simTexelSize.x, simTexelSize.y);
    gl.uniform1i(programs.curl.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    // vorticity
    gl.useProgram(programs.vorticity.program);
    gl.uniform2f(programs.vorticity.uniforms.texelSize, simTexelSize.x, simTexelSize.y);
    gl.uniform1i(programs.vorticity.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(programs.vorticity.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(programs.vorticity.uniforms.curl, config.CURL);
    gl.uniform1f(programs.vorticity.uniforms.dt, dt);
    blit(velocity.write); velocity.swap();

    // divergence
    gl.useProgram(programs.divergence.program);
    gl.uniform2f(programs.divergence.uniforms.texelSize, simTexelSize.x, simTexelSize.y);
    gl.uniform1i(programs.divergence.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    // clear pressure
    gl.useProgram(programs.clear.program);
    gl.uniform1i(programs.clear.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(programs.clear.uniforms.value, config.PRESSURE);
    blit(pressure.write); pressure.swap();

    // pressure
    gl.useProgram(programs.pressure.program);
    gl.uniform2f(programs.pressure.uniforms.texelSize, simTexelSize.x, simTexelSize.y);
    gl.uniform1i(programs.pressure.uniforms.uDivergence, divergence.attach(0));
    for (var i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(programs.pressure.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write); pressure.swap();
    }

    // gradient subtract
    gl.useProgram(programs.gradientSubtract.program);
    gl.uniform2f(programs.gradientSubtract.uniforms.texelSize, simTexelSize.x, simTexelSize.y);
    gl.uniform1i(programs.gradientSubtract.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(programs.gradientSubtract.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write); velocity.swap();

    // advection velocity
    gl.useProgram(programs.advection.program);
    gl.uniform2f(programs.advection.uniforms.texelSize, simTexelSize.x, simTexelSize.y);
    gl.uniform2f(programs.advection.uniforms.dyeTexelSize, simTexelSize.x, simTexelSize.y);
    gl.uniform1i(programs.advection.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(programs.advection.uniforms.uSource, velocity.read.attach(0));
    gl.uniform1f(programs.advection.uniforms.dt, dt);
    gl.uniform1f(programs.advection.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity.write); velocity.swap();

    // advection density
    var dyeTexelSize = { x: 1.0/dyeWidth, y: 1.0/dyeHeight };
    gl.uniform2f(programs.advection.uniforms.dyeTexelSize, dyeTexelSize.x, dyeTexelSize.y);
    gl.uniform1i(programs.advection.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(programs.advection.uniforms.uSource, density.read.attach(1));
    gl.uniform1f(programs.advection.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(density.write); density.swap();
  }

  function render() {
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
    gl.useProgram(programs.display.program);
    gl.uniform1i(programs.display.uniforms.uTexture, density.read.attach(0));
    blit(null);
  }

  function update() {
    resizeCanvas();
    var now = Date.now();
    var dt  = Math.min((now - lastTime) / 1000, 0.016666);
    lastTime = now;

    if (splatStack.length > 0) multipleSplats(splatStack.pop());

    pointers.forEach(function(p) {
      if (p.moved) {
        p.moved = false;
        splat(p.texcoordX, p.texcoordY, p.deltaX * config.SPLAT_FORCE, p.deltaY * config.SPLAT_FORCE, p.color);
      }
    });

    step(dt);
    render();
    requestAnimationFrame(update);
  }

  multipleSplats(parseInt(Math.random() * 20) + 5);
  requestAnimationFrame(update);

})();
