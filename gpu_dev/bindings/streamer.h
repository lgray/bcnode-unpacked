// this was originally taken from the avon package                              // and modified to suit the needs of the GPU miner

#ifndef STREAMER_H
#define STREAMER_H

#include <node.h>
#include "BCGPUMiner.h"

class BCGPUResult : public node::ObjectWrap {
 public:
  static NAN_MODULE_INIT(Initialize);
  static NAN_METHOD(New);
  //static NAN_METHOD(NewInstance);

  BCGPUResult() {}
  BCGPUResult(const bc_mining_outputs&);
  ~BCGPUResult() {  }

  static NAN_METHOD(GetResult) {
    BCGPUResult* obj = ObjectWrap::Unwrap<BCGPUResult>(info.Holder());
    info.GetReturnValue().Set(Nan::CopyBuffer((const char*)obj->result_blake2b,BLAKE2B_OUTBYTES).ToLocalChecked());
  }
  static NAN_METHOD(GetDistance) {
    BCGPUResult* obj = ObjectWrap::Unwrap<BCGPUResult>(info.Holder());
    info.GetReturnValue().Set(Nan::CopyBuffer(obj->distance.c_str(),obj->distance.size()).ToLocalChecked());
  }
  static NAN_METHOD(GetDifficulty) {
    BCGPUResult* obj = ObjectWrap::Unwrap<BCGPUResult>(info.Holder());
    info.GetReturnValue().Set(Nan::CopyBuffer(obj->difficulty.c_str(),obj->difficulty.size()).ToLocalChecked());
  }
  static NAN_METHOD(GetIterations) {
    BCGPUResult* obj = ObjectWrap::Unwrap<BCGPUResult>(info.Holder());
    info.GetReturnValue().Set(obj->iterations);
  }
  static NAN_METHOD(GetNonce) {
    BCGPUResult* obj = ObjectWrap::Unwrap<BCGPUResult>(info.Holder());
    info.GetReturnValue().Set(obj->nonce);
  }
  
 private:
  char result_blake2b[BLAKE2B_OUTBYTES]; 
  std::string distance, difficulty; 
  uint32_t iterations, nonce; 
  
  static inline Nan::Persistent<v8::Function> & constructor() {
    static Nan::Persistent<v8::Function> cons;
    return cons;
  }
};

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
