class MeetingPCM extends AudioWorkletProcessor {
  buffer=new Int16Array(2400); index=0;
  process(inputs){const channels=inputs[0];if(channels?.length){
    for(let i=0;i<channels[0].length;i++){let sample=0;for(const channel of channels)sample+=channel[i]/channels.length;
      this.buffer[this.index++]=Math.max(-1,Math.min(1,sample))*32767;
      if(this.index===this.buffer.length){this.port.postMessage(this.buffer,[this.buffer.buffer]);this.buffer=new Int16Array(2400);this.index=0;}
    }
  }return true;}
}registerProcessor('meeting-pcm',MeetingPCM);
