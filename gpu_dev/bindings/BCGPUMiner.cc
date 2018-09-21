#include "BCGPUMiner.h"

#include <iostream>

BCGPUMiner::BCGPUMiner() {}
BCGPUMiner::~BCGPUMiner() {}


void BCGPUMiner::init_memory() {
  std::cout << "init BCGPUMiner!" << std::endl;
  init_mining_memory(thepool);
}

void BCGPUMiner::destroy_memory() {
  std::cout << "destroy BCGPUMiner" << std::endl;
  destroy_mining_memory(thepool);
}

void BCGPUMiner::do_mining(const bc_mining_inputs& in,
                           bc_mining_outputs& out) {
  std::cout << "running BCGPUMiner!" << std::endl;
  run_miner(in,thepool,out);
}
