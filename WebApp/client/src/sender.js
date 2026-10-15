import {
  Mouse,
  Keyboard,
  Gamepad,
  Touchscreen,
  StateEvent,
  TextEvent
} from "./inputdevice.js";

import { LocalInputManager } from "./inputremoting.js";
import { GamepadHandler } from "./gamepadhandler.js";
import { PointerCorrector } from "./pointercorrect.js";

export class Sender extends LocalInputManager {
  constructor(elem) {
    super();
    this._devices = [];
    this._listeners = [];
    this._elem = elem;
    this._corrector = new PointerCorrector(
      this._elem.videoWidth,
      this._elem.videoHeight,
      this._elem
      );

    //since line 27 cannot complete resize initialization but can only monitor div dimension changes, line 26 needs to be reserved
    this._listen(this._elem, 'resize', this._onResizeEvent);
    this._observer = new ResizeObserver(this._onResizeEvent.bind(this));
    this._observer.observe(this._elem);
  }

  _listen(target, name, callback) {
    const bound = callback.bind(this);
    target.addEventListener(name, bound, false);
    this._listeners.push([target, name, bound]);
  }

  dispose() {
    this._observer.disconnect();
    for (const [target, name, callback] of this._listeners) target.removeEventListener(name, callback, false);
    this._listeners = [];
    this._gamepadHandler?.dispose();
  }

  addMouse() {
    const descriptionMouse = {
      m_InterfaceName: "RawInput",
      m_DeviceClass: "Mouse",
      m_Manufacturer: "",
      m_Product: "",
      m_Serial: "",
      m_Version: "",
      m_Capabilities: ""
    };
    this.mouse = new Mouse("Mouse", "Mouse", 1, null, descriptionMouse);
    this._devices.push(this.mouse);

    this._listen(this._elem, 'click', this._onMouseEvent);
    this._listen(this._elem, 'mousedown', this._onMouseEvent);
    this._listen(this._elem, 'mouseup', this._onMouseEvent);
    this._listen(this._elem, 'mousemove', this._onMouseEvent);
    this._listen(this._elem, 'wheel', this._onWheelEvent);
  }

  addKeyboard() {
    const descriptionKeyboard = {
      m_InterfaceName: "RawInput",
      m_DeviceClass: "Keyboard",
      m_Manufacturer: "",
      m_Product: "",
      m_Serial: "",
      m_Version: "",
      m_Capabilities: ""
    };
    this.keyboard = new Keyboard("Keyboard", "Keyboard", 2, null, descriptionKeyboard);
    this._devices.push(this.keyboard);

    this._listen(document, 'keyup', this._onKeyEvent);
    this._listen(document, 'keydown', this._onKeyEvent);
  }

  addGamepad() {
    const descriptionGamepad = {
      m_InterfaceName: "RawInput",
      m_DeviceClass: "Gamepad",
      m_Manufacturer: "",
      m_Product: "",
      m_Serial: "",
      m_Version: "",
      m_Capabilities: ""
    };
    this.gamepad = new Gamepad("Gamepad", "Gamepad", 3, null, descriptionGamepad);
    this._devices.push(this.gamepad);

    this._listen(window, "gamepadconnected", this._onGamepadEvent);
    this._listen(window, "gamepaddisconnected", this._onGamepadEvent);
    this._gamepadHandler = new GamepadHandler();
    this._listen(this._gamepadHandler, "gamepadupdated", this._onGamepadEvent);
  }

  addTouchscreen() {
    const descriptionTouch = {
      m_InterfaceName: "RawInput",
      m_DeviceClass: "Touch",
      m_Manufacturer: "",
      m_Product: "",
      m_Serial: "",
      m_Version: "",
      m_Capabilities: ""
    };
    this.touchscreen = new Touchscreen("Touchscreen", "Touchscreen", 4, null, descriptionTouch);
    this._devices.push(this.touchscreen);

    this._listen(this._elem, 'touchend', this._onTouchEvent);
    this._listen(this._elem, 'touchstart', this._onTouchEvent);
    this._listen(this._elem, 'touchcancel', this._onTouchEvent);
    this._listen(this._elem, 'touchmove', this._onTouchEvent);
    this._listen(this._elem, 'click', this._onTouchEvent);
  }

  /**
   * @returns {InputDevice[]}
   */
  get devices() {
    return this._devices;
  }

  _onResizeEvent() {
    this._corrector.reset(
      this._elem.videoWidth,
      this._elem.videoHeight,
      this._elem
    );
  }
  _onMouseEvent(event) {
    this.mouse.queueEvent(event);
    this.mouse.currentState.position = this._corrector.map(this.mouse.currentState.position);
    this._queueStateEvent(this.mouse.currentState, this.mouse);
  }
  _onWheelEvent(event) {
    this.mouse.queueEvent(event);
    this._queueStateEvent(this.mouse.currentState, this.mouse);
  }
  _onKeyEvent(event) {
    if(event.type == 'keydown') {
      if(!event.repeat) { // StateEvent
        this.keyboard.queueEvent(event);
        this._queueStateEvent(this.keyboard.currentState, this.keyboard);
      }
      // TextEvent
      this._queueTextEvent(this.keyboard, event);
    }
    else if(event.type == 'keyup') {
      this.keyboard.queueEvent(event);
      this._queueStateEvent(this.keyboard.currentState, this.keyboard);
    }
  }
  _onTouchEvent(event) {
    this.touchscreen.queueEvent(event, this.timeSinceStartup);
    for(let touch of this.touchscreen.currentState.touchData) {
      let clone = touch.copy();
      clone.position = this._corrector.map(clone.position);
      this._queueStateEvent(clone, this.touchscreen);
    }
  }
  _onGamepadEvent(event) {
    switch(event.type) {
      case 'gamepadconnected': {
        this._gamepadHandler.addGamepad(event.gamepad);
        break;
      }
      case 'gamepaddisconnected': {
        this._gamepadHandler.removeGamepad(event.gamepad);
        break;
      }
      case 'gamepadupdated': {
        this.gamepad.queueEvent(event);
        this._queueStateEvent(this.gamepad.currentState, this.gamepad);
        break;
      }
    }
  }

  _queueStateEvent(state, device) {
    const stateEvent =
      StateEvent.fromState(state, device.deviceId, this.timeSinceStartup);
    const e = new CustomEvent(
      'event', {detail: { event: stateEvent, device: device}});
    super.onEvent.dispatchEvent(e);
  }
  _queueTextEvent(device, event) {
    const textEvent = TextEvent.create(device.deviceId, event, this.timeSinceStartup);
    const e = new CustomEvent(
      'event', {detail: { event: textEvent, device: device}});
    super.onEvent.dispatchEvent(e);
  }
  _queueDeviceChange(device, usage) {
    const e = new CustomEvent(
      'changedeviceusage', {detail: { device: device, usage: usage }});
    super.onEvent.dispatchEvent(e);
  }
}

export class Observer {
  /**
   *
   * @param {RTCDataChannel} channel
   */
  constructor(channel) {
    this.channel = channel;
  }
  /**
   *
   * @param {Message} message
   */
  onNext(message) {
    if(this.channel == null || this.channel.readyState != 'open') {
      return;
    }
    this.channel.send(message.buffer);
  }
}
