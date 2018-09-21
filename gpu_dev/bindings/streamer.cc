// this was originally taken from the avon package
// and modified to suit the needs of the GPU miner

#include <iostream>
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

std::mutex BCGPUStream::miner_lock;

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

BCGPUStream::BCGPUStream() {
  std::cout << "constructing BCGPUStream" << std::endl;
}

BCGPUStream::~BCGPUStream() {
  std::cout << "destructing BCGPUStream" << std::endl;
}

NAN_METHOD(BCGPUStream::RunMiner) {

  std::lock_guard<std::mutex> lock(miner_lock);

  bc_mining_inputs in;
  bc_mining_outputs out;
  BCGPUStream* obj = ObjectWrap::Unwrap<BCGPUStream>(info.Holder());

  obj->mMiner.init_memory();
  
  // first arg is the miner key
  Local<Object> minerkeybuffer = info[0].As<Object>();
  size_t minerkeylength = node::Buffer::Length(minerkeybuffer);
  char* minerkeydata = node::Buffer::Data(minerkeybuffer);
  memcpy(in.miner_key_,minerkeydata,minerkeylength);
  in.miner_key_size_ = minerkeylength;

  std::cout << "miner key: " << in.miner_key_ << ' ' << minerkeylength << std::endl;


  // merkel root from BC
  Local<Object> merkelbuffer = info[1].As<Object>();
  size_t merkellength = node::Buffer::Length(merkelbuffer);
  char* merkeldata = node::Buffer::Data(merkelbuffer);
  memcpy(in.merkel_root_,merkeldata,merkellength);
  assert(merkellength == BLAKE2B_OUTBYTES);

  std::cout << "merkel root: " << in.merkel_root_ << ' ' << merkellength << std::endl;
  
  // the work hash from BC
  Local<Object> workbuffer = info[2].As<Object>();
  size_t worklength = node::Buffer::Length(workbuffer);
  char* workdata = node::Buffer::Data(workbuffer);
  //memcpy(in.received_work_,workdata,worklength);
  memset(in.received_work_,0,BLAKE2B_OUTBYTES);
  in.work_size_ = worklength;
  assert(worklength == BLAKE2B_OUTBYTES);

  for(unsigned i = 0; i < in.work_size_; ++i ) {
      char temp[2];
      temp[0] = workdata[i];
      temp[1] = '\0';
      in.received_work_[i/2] += strtol(temp,NULL,16)<<(4*((i+1)%2));
    }

  std::cout << "received work: ";
  for( unsigned i = 0; i < BLAKE2B_OUTBYTES ; ++i ) {
    std::cout << std::hex << (unsigned)(in.received_work_[i]>>4) << (unsigned)(in.received_work_[i]&0xf);
  }
  std::cout << std::dec << std::endl;
    
  // the timestamp from BC
  Local<Object> tsbuffer = info[3].As<Object>();
  size_t tslength = node::Buffer::Length(tsbuffer);
  char* tsdata = node::Buffer::Data(tsbuffer);
  memcpy(in.time_stamp_,tsdata,tslength);
  in.time_stamp_size_ = tslength;

  std::cout << "timestamp: " << tsdata << ' ' << tslength << std::endl;
  
  // the difficulty
  Local<Object> diffbuffer = info[4].As<Object>();
  char* diffdata = node::Buffer::Data(diffbuffer);
  char* end;
  uint64_t thediff = strtoull(diffdata,&end,10);
  in.the_difficulty_ = thediff;

  std::cout << "difficulty: " << in.the_difficulty_ << std::endl;

  //std::lock_guard<std::mutex> lock(miner_lock);
  obj->mMiner.do_mining(in,out);

  obj->mMiner.destroy_memory();
  
  v8::Isolate* isolate = info.GetIsolate();
  
  Local<Object> jsout = Object::New(isolate);

  std::stringstream ssdist, ssiters, ssdiff, result;
  ssdist << out.distance_;
  ssiters << out.iterations_;
  ssdiff << out.difficulty_;

  //convert to blake2bl stringified form
  for( unsigned i = 32; i < BLAKE2B_OUTBYTES; ++i ) {
    result << std::hex 
	   << (unsigned)(out.result_blake2b_[i]>>4)
	   << (unsigned)(out.result_blake2b_[i]&0xf);
  }
  
  jsout->Set( v8::String::NewFromUtf8(isolate,"nonce"),
	      v8::Uint32::NewFromUnsigned(isolate,out.nonce_) );
  jsout->Set( v8::String::NewFromUtf8(isolate,"result_blake2bl"),
	      v8::String::NewFromUtf8(isolate,result.str().c_str()) );
  jsout->Set( v8::String::NewFromUtf8(isolate,"distance"),
	      v8::String::NewFromUtf8(isolate,ssdist.str().c_str()) );
  jsout->Set( v8::String::NewFromUtf8(isolate,"iterations"),
              v8::String::NewFromUtf8(isolate,ssiters.str().c_str()) );
  jsout->Set( v8::String::NewFromUtf8(isolate,"difficulty"),
              v8::String::NewFromUtf8(isolate,ssdiff.str().c_str()) );
    
  std::cout << "distance: " << out.distance_ << std::endl;
  std::cout << "nonce: " << out.nonce_ << std::endl;
  std::cout << "iterations: " << out.iterations_ << std::endl;
  
  // set the return value
  info.GetReturnValue().Set(jsout);
}

// --- v8 module ceremony

NAN_MODULE_INIT(BCGPUStream::Initialize) {
  v8::Local<v8::FunctionTemplate> t = Nan::New<v8::FunctionTemplate>(New);
  
  t->SetClassName(Nan::New<String>("BCGPUStream").ToLocalChecked());
  t->InstanceTemplate()->SetInternalFieldCount(1);
  
  Nan::SetPrototypeMethod(t, "RunMiner", BCGPUStream::RunMiner);
  
  constructor().Reset(Nan::GetFunction(t).ToLocalChecked());
  Nan::Set(target, Nan::New("BCGPUStream").ToLocalChecked(), Nan::GetFunction(t).ToLocalChecked());
}

NAN_MODULE_INIT(InitAll)
{
	BCGPUStream::Initialize(target);
}

NODE_MODULE(bcminer_gpu, InitAll)
