// this was originally taken from the avon package
// and modified to suit the needs of the GPU miner

#include <ctype.h>
#include <stdio.h>
#include <cstdlib>
#include <sstream>

#include <node.h>
#include "nan.h"

#include "streamer.h"

#define HERE() ({fprintf(stderr, "@%d\n", __LINE__);})

using namespace v8;
using namespace node;

//BCGPUResult

BCGPUResult::BCGPUResult(const bc_mining_outputs& outs) {
  // first return value is the result in full blake2b form
  memcpy(result_blake2b,outs.result_blake2b_,BLAKE2B_OUTBYTES);
  
  // second is the distance
  
  // third is the difficulty as a string
  
  // fourth is iterations
  iterations = uint32_t(outs.iterations_);
  
  // fifth is nonce
  nonce = outs.nonce_;
}

NAN_METHOD(BCGPUResult::New) {
  if (info.IsConstructCall())
    {
      bc_mining_outputs outs;      
      if( !info[0]->IsUndefined() ) {
        // first is the buffer
        memset(outs.result_blake2b_,0,BLAKE2B_OUTBYTES);
        Local<Object> resultbuffer = info[0].As<Object>();
        size_t resultlength = node::Buffer::Length(resultbuffer);
        char* resultdata = node::Buffer::Data(resultbuffer);
        assert(resultlength == BLAKE2B_OUTBYTES);
        memcpy(outs.result_blake2b_,resultdata,resultlength);
      }

      outs.iterations_ = info[3]->IsUndefined() ? 0 : Nan::To<uint32_t>(info[3]).FromJust();
      outs.nonce_ = info[4]->IsUndefined() ? 0 : Nan::To<uint32_t>(info[4]).FromJust();

      BCGPUResult* obj = new BCGPUResult(outs);
      obj->Wrap(info.This());
      info.GetReturnValue().Set(info.This());
    }
  else
    {
      const int argc = 0;
      Local<Value> argv[argc] = { };
      v8::Local<v8::Function> cons = Nan::New(constructor());
      info.GetReturnValue().Set(Nan::NewInstance(cons, argc, argv).ToLocalChecked());
    }
}

NAN_MODULE_INIT(BCGPUResult::Initialize) {
  v8::Local<v8::FunctionTemplate> t = Nan::New<v8::FunctionTemplate>(New);
  
  t->SetClassName(Nan::New<String>("BCGPUResult").ToLocalChecked());
  t->InstanceTemplate()->SetInternalFieldCount(5);
  
  Nan::SetPrototypeMethod(t, "GetResult", BCGPUResult::GetResult);
  Nan::SetPrototypeMethod(t, "GetDistance", BCGPUResult::GetResult);
  Nan::SetPrototypeMethod(t, "GetDifficulty", BCGPUResult::GetResult);
  Nan::SetPrototypeMethod(t, "GetIterations", BCGPUResult::GetResult);
  Nan::SetPrototypeMethod(t, "GetNonce", BCGPUResult::GetResult);
  
  constructor().Reset(Nan::GetFunction(t).ToLocalChecked());
  Nan::Set(target, Nan::New("BCGPUResult").ToLocalChecked(), Nan::GetFunction(t).ToLocalChecked());
}

/// BCGPUStream

NAN_METHOD(BCGPUStream::New) {
  if (info.IsConstructCall())
    {
      
      BCGPUStream* obj = new BCGPUStream();
      obj->Wrap(info.This());
      info.GetReturnValue().Set(info.This());
    }
  else
    {
      const int argc = 0;
      Local<Value> argv[argc] = { };
      v8::Local<v8::Function> cons = Nan::New(constructor());
      info.GetReturnValue().Set(Nan::NewInstance(cons, argc, argv).ToLocalChecked());
    }
}

BCGPUStream::BCGPUStream()
{}

BCGPUStream::~BCGPUStream()
{}

NAN_METHOD(BCGPUStream::RunMiner) {
  bc_mining_inputs in;
  bc_mining_outputs out;
  BCGPUStream* obj = ObjectWrap::Unwrap<BCGPUStream>(info.Holder());

  // first arg is the miner key
  Local<Object> minerkeybuffer = info[0].As<Object>();
  size_t minerkeylength = node::Buffer::Length(minerkeybuffer);
  char* minerkeydata = node::Buffer::Data(minerkeybuffer);
  memcpy(in.miner_key_,minerkeydata,minerkeylength);
  in.miner_key_size_ = minerkeylength;

  // merkel root from BC
  Local<Object> merkelbuffer = info[1].As<Object>();
  size_t merkellength = node::Buffer::Length(merkelbuffer);
  char* merkeldata = node::Buffer::Data(merkelbuffer);
  memcpy(in.merkel_root_,merkeldata,merkellength);
  assert(merkellength == BLAKE2B_OUTBYTES);

  // the work hash from BC
  Local<Object> workbuffer = info[2].As<Object>();
  size_t worklength = node::Buffer::Length(workbuffer);
  char* workdata = node::Buffer::Data(workbuffer);
  memcpy(in.received_work_,workdata,worklength);
  in.work_size_ = worklength;
  assert(worklength == BLAKE2B_OUTBYTES);

  // the timestamp from BC
  Local<Object> tsbuffer = info[3].As<Object>();
  size_t tslength = node::Buffer::Length(tsbuffer);
  char* tsdata = node::Buffer::Data(tsbuffer);
  memcpy(in.time_stamp_,tsdata,tslength);
  in.time_stamp_size_ = tslength;

  // the difficulty
  Local<Object> diffbuffer = info[4].As<Object>();
  char* diffdata = node::Buffer::Data(diffbuffer);
  char* end;
  uint64_t thediff = strtoull(diffdata,&end,10);
  in.the_difficulty_ = thediff;
  
  obj->mMiner.do_mining(in,out);

  BCGPUResult result(out);
  

  // set the return value
  //info.GetReturnValue().Set(result);
}

// --- v8 module ceremony

NAN_MODULE_INIT(BCGPUStream::Initialize) {
  v8::Local<v8::FunctionTemplate> t = Nan::New<v8::FunctionTemplate>(New);
  
  t->SetClassName(Nan::New<String>("BCGPUStream").ToLocalChecked());
  t->InstanceTemplate()->SetInternalFieldCount(1);
  
  Nan::SetPrototypeMethod(t, "run_miner", BCGPUStream::RunMiner);
  
  constructor().Reset(Nan::GetFunction(t).ToLocalChecked());
  Nan::Set(target, Nan::New("BCGPUStream").ToLocalChecked(), Nan::GetFunction(t).ToLocalChecked());
}
