#include "BCGPUMiner.h"

BCGPUMiner::BCGPUMiner() {
  init_mining_memory(thepool);
}

BCGPUMiner::~BCGPUMiner() {
  destroy_mining_memory(thepool);
}

void BCGPUMiner::do_mining(const bc_mining_inputs& in,
                           bc_mining_outputs& out) {
  run_miner(in,thepool,out);
}
