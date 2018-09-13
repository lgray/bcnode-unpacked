#include "blake2.h"
#include "blake2b.cu"

struct BCHash {
   blake2b_state state;
};

#include <iostream>

int main(int argc, char **argv) {
    BCHash cpu = BCHash();
    BCHash gpu = BCHash();

    uint8_t empty_cpu[2], empty_gpu[2];
    uint8_t hash_cpu[BLAKE2B_OUTBYTES], hash_gpu[BLAKE2B_OUTBYTES];
    
    memset(empty_cpu,0,sizeof(empty_cpu));
    memset(empty_gpu,0,sizeof(empty_gpu));

    blake2b_init(&cpu.state,BLAKE2B_OUTBYTES);
    blake2b_update(&cpu.state,empty_cpu,0);
    blake2b_final(&cpu.state,hash_cpu,BLAKE2B_OUTBYTES);

    std::cout << BLAKE2B_OUTBYTES << std::endl;

    std::cout << "cpu: " << uint32_t(cpu.state.buflen) << " 0x" << std::hex;
    for( unsigned i = 0; i < BLAKE2B_OUTBYTES ; ++i ) {
    	 std::cout << std::hex << (unsigned)(hash_cpu[i]>>4) << (unsigned)(hash_cpu[i]&0xf);
    }
    std::cout << std::dec << std::endl;

    blake2b_init_cu(&gpu.state,BLAKE2B_OUTBYTES);
    std::cout << "gpu: " << uint32_t(gpu.state.buflen) << " 0x" << std::hex;   
    blake2b_update_cu(&gpu.state,empty_gpu,0);
    blake2b_final_cu(&gpu.state,hash_gpu,BLAKE2B_OUTBYTES);
    for( unsigned i = 0; i < BLAKE2B_OUTBYTES ; ++i ) {
    	 std::cout << std::hex << (unsigned)(hash_gpu[i]>>4) << (unsigned)(hash_gpu[i]&0xf);
    }
    std::cout << std::dec << std::endl;

    return 0;
}
