#include "blake2.h"
#include "blake2b.cu"

struct BCHash {
   blake2b_state state;
};

#include <iostream>

int main(int argc, char **argv) {
    BCHash cpu = BCHash();
    BCHash gpu = BCHash();

    std::cout << "cpu: " << uint32_t(cpu.state.buflen) << std::endl;
    std::cout << "gpu: " << uint32_t(gpu.state.buflen) << std::endl;

    return 0;
}