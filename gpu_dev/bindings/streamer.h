// this was originally taken from the avon package                              // and modified to suit the needs of the GPU miner

#ifndef STREAMER_H
#define STREAMER_H

#include <node.h>
#include "BCGPUMiner.h"

class BCGPUStream : public node::ObjectWrap {
 public:
  static NAN_MODULE_INIT(Initialize);
  static NAN_METHOD(New);
  
  BCGPUStream();
  ~BCGPUStream();
  
  static NAN_METHOD(RunMiner);		
  
 private:
 
  BCGPUMiner mMiner;
  
  static inline Nan::Persistent<v8::Function> & constructor() {
    static Nan::Persistent<v8::Function> cons;
    return cons;
  }
};

#endif
