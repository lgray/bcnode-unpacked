#include "blake2.h"
#include "bc_miner.h"

#include <string>
#include <vector>
#include <algorithm>
#include <ctime>
#include <pthread.h>
#include <assert.h>

#include <iostream>

/*
INFO	 mining.thread worker 4517 reporting in 
INFO	 mining.primitives twork: 7296c034e95304ee2a69c2a61e6287a0 58448d08d723222d19658c0364dd247c 64
                                  58448d08d723222d19658c0364dd247c
INFO	 mining.primitives miner: 0xf34fa87db39d15471bebe997860dcd49fc259318 42 
INFO	 mining.primitives merkl: 108459d41ce2399e13992528ea1bd9940fac9df181e29c2b61caeaad55f6532a 64 
INFO	 mining.primitives nhash: 1af153f4cf971b61cc867b760bebfbc98a8c216cd69d6bb5dbb63aaed9db1fc3 64 
INFO	 mining.primitives times: 1536810114 10 
INFO	 mining.primitives cocat: 0xf34fa87db39d15471bebe997860dcd49fc259318108459d41ce2399e13992528ea1bd9940fac9df181e29c2b61caeaad55f6532a1af153f4cf971b61cc867b760bebfbc98a8c216cd69d6bb5dbb63aaed9db1fc31536810114 180 
INFO	 mining.primitives solun: 2b08d9146a6ce1f02db88203bdc653cd0b5e33ec945f391f82dbe3d417fb586e 64 
INFO	 mining.primitives wrkck: 53,56,52,52,56,100,48,56,100,55,50,51,50,50,50,100,49,57,54,53,56,99,48,51,54,52,100,100,50,52,55,99, 55,50,57,54,99,48,51,52,101,57,53,51,48,52,101,101,50,97,54,57,99,50,97,54,49,101,54,50,56,55,97,48 2 
INFO	 mining.primitives compr: 2b08d9146a6ce1f02db88203bdc653cd0b5e33ec945f391f82dbe3d417fb586e 64 
INFO	 mining.primitives testr: 204933315567342 undefined
*/

int mypow(int base, int exp) {
  int result = 1;
  while( exp-- ) { result *= base; }
  return result;
}

struct sort_by_distance {
  const size_t* distances;
  bool operator()(size_t i1,size_t i2) const {
    //std::cout << i1 << ' ' << distances[i1] << " >?= " << i2 << ' ' << distances[i2] << std::endl;
    return distances[i1] >= distances[i2]; 
  }
};

int main(int argc, char **argv) {
    
    std::string work ("0edd781347cfc9c3ff49fdc423c7f1a3deae6501e5cef6b99c45c8901f763320");
    std::string mhash("0xf34fa87db39d15471bebe997860dcd49fc259318");
    std::string merkl("7aff5341ec1a1caa51c74c162c7f2a3946fe28f23b6e630de995f74d5767f865");
    uint32_t thenonce = 2060688607;
    uint8_t nonce_string[12]; // ten bytes and a null character max;
    memset(nonce_string,0,12);
    // convert nonce
    static uint16_t num_to_code[16] = {48,49,50,51,52,53,54,55,56,57};
    nonce_string[0] = '0'; // take care of base case
    uint32_t length = 0;
    while( thenonce >= std::pow(10,length) ) { ++length; }
    std::cout << "the length: " << length << std::endl;
    for( uint32_t i = 0; i < length; ++i ){
      nonce_string[length-i-1] = num_to_code[(thenonce/mypow(10,i))%10];
    }
    std::cout << thenonce << ' ' << nonce_string << std::endl;    
    std::string nhash("cb5d17fe5c27f7b7426002eb665142d00190553b9d945a936eed3ffd23cdde71");
    std::string times("1536783719");

    std::string the_thing = mhash + merkl + nhash + times;

    std::string result_bc("c0d42acc9793a81096411b74b78fe9a12645737c57ee1544fb35d5fa6f09503e");
        
    // now let's do it on the GPU for real
    size_t stash_size = mhash.length();
    size_t tstamp_size = times.length();
        
    std::vector<bc_mining_stream> streams;    
    
    init_gpus(streams);

    std::vector<pthread_t> threads(streams.size());
    std::vector<bc_thread_data> thread_data(streams.size());

    bc_mining_inputs* in; 
    cudaMallocHost(&in,streams.size()*sizeof(bc_mining_inputs));
    bc_mining_outputs* out;
    cudaMallocHost(&out,streams.size()*sizeof(bc_mining_outputs));
    
    for(unsigned iGPU = 0; iGPU < streams.size(); ++iGPU ) {
      in[iGPU].miner_key_size_ = mhash.length();
      in[iGPU].time_stamp_size_ = times.length();
      in[iGPU].work_size_ = work.length();    
      in[iGPU].the_difficulty_ = 303810187437540ULL;
      
      memcpy(in[iGPU].miner_key_,mhash.c_str(),in[iGPU].miner_key_size_);
      memcpy(in[iGPU].merkel_root_,merkl.c_str(),BLAKE2B_OUTBYTES);
      memcpy(in[iGPU].time_stamp_,times.c_str(),in[iGPU].time_stamp_size_);
      //set the work
      for(unsigned i = 0; i < in[iGPU].work_size_; ++i ) {
	char temp[2];
	temp[0] = work[i];
	temp[1] = '\0';
	in[iGPU].received_work_[i/2] += strtol(temp,NULL,16)<<(4*((i+1)%2));
      }

      thread_data[iGPU].in = in + iGPU;
      thread_data[iGPU].out = out + iGPU;
      thread_data[iGPU].stream = &streams[iGPU];
    }

    int result_code;
    for( unsigned iGPU = 0; iGPU < streams.size(); ++iGPU ) {      
      result_code = pthread_create(&threads[iGPU], NULL, run_miner_thread, &thread_data[iGPU]);
      assert(!result_code);
    }
    
    
    for ( unsigned iGPU = 0; iGPU < streams.size(); ++iGPU) {
      // block until thread 'index' completes
      result_code = pthread_join(threads[iGPU], NULL);
      assert(!result_code);
      std::cout << "In main: thread " << iGPU <<" has completed" << std::endl;
    }

    for( unsigned iGPU = 0; iGPU < streams.size(); ++iGPU ) {
      std::cout << "gpu: " << streams[iGPU].device << " trial = 0x" << std::hex;
      // output "blake2bl"
      for( unsigned i = 32; i < BLAKE2B_OUTBYTES; ++i ) {
	std::cout << std::hex << (unsigned)(out[iGPU].result_blake2b_[i]>>4) << (unsigned)(out[iGPU].result_blake2b_[i]&0xf);
      }
      std::cout << std::dec << std::endl;
      std::cout << "gpu distance is: " << out[iGPU].distance_ << std::endl;
    }

    destroy_gpus(streams);
    
    cudaFreeHost(in);
    cudaFreeHost(out);
    
    return 0;
}
