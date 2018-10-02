#include "BCGPUMiner.h"

#include <iostream>
#include <cassert>
#include <pthread.h>
#include <cstring>

BCGPUMiner::BCGPUMiner() {}
BCGPUMiner::~BCGPUMiner() {}


void BCGPUMiner::init_memory() {
  std::cout << "init BCGPUMiner!" << std::endl;
  init_gpus(streams);  
}

void BCGPUMiner::destroy_memory() {
  std::cout << "destroy BCGPUMiner" << std::endl;
  destroy_gpus(streams);
}

void BCGPUMiner::do_mining(const bc_mining_inputs& in,
                           bc_mining_outputs& out) {
  std::cout << "running BCGPUMiner!" << std::endl;
  std::vector<pthread_t> threads(streams.size());
  std::vector<bc_thread_data> thread_data(streams.size());

  std::vector<bc_mining_outputs> outs(streams.size());
  
  for(unsigned iGPU = 0; iGPU < streams.size(); ++iGPU) {
    thread_data[iGPU].in = &in;
    thread_data[iGPU].out = &outs[iGPU];
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
    //std::cout << "In do_mining: thread " << iGPU <<" has completed" << std::endl;
  }

  unsigned best_result = 0;
  uint64_t best_distance = 0;
  for( unsigned iGPU = 0; iGPU < streams.size(); ++iGPU) {
    if( outs[iGPU].distance_ > best_distance ) {
      best_result = iGPU;
      best_distance = outs[iGPU].distance_;
    }
  }
  memcpy(&out,&outs[best_result],sizeof(bc_mining_outputs));
  out.iterations_ *= streams.size();
}
