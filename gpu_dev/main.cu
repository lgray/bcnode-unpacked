#include "blake2.h"
#include "blake2b.cu"
#include "cos_dist.cu"

#include <string>

struct BCHash {
   blake2b_state state;
};

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

int main(int argc, char **argv) {
    BCHash cpu = BCHash();
    BCHash gpu = BCHash();

    std::string work("7296c034e95304ee2a69c2a61e6287a058448d08d723222d19658c0364dd247c");
    std::string mhash("0xf34fa87db39d15471bebe997860dcd49fc259318");
    std::string merkl("108459d41ce2399e13992528ea1bd9940fac9df181e29c2b61caeaad55f6532a");
    std::string nhash    ("1af153f4cf971b61cc867b760bebfbc98a8c216cd69d6bb5dbb63aaed9db1fc3");
    std::string times("1536810114");

    std::string the_thing = mhash + merkl + nhash + times;

    std::string result_bc("2b08d9146a6ce1f02db88203bdc653cd0b5e33ec945f391f82dbe3d417fb586e");
    
    std::cout << the_thing << std::endl;
    std::cout << result_bc << std::endl;
    
    uint8_t empty_cpu[1024], empty_gpu[1024];
    uint8_t hash_cpu[BLAKE2B_OUTBYTES], hash_gpu[BLAKE2B_OUTBYTES];
    uint8_t work_char[BLAKE2B_OUTBYTES];

    memset(empty_cpu,0,1024*sizeof(uint8_t));
    memset(empty_gpu,0,1024*sizeof(uint8_t));
    memset(work_char,0,BLAKE2B_OUTBYTES*sizeof(uint8_t));
    
    memcpy(empty_cpu,the_thing.c_str(),the_thing.size()*sizeof(uint8_t));
    memcpy(empty_gpu,the_thing.c_str(),the_thing.size()*sizeof(uint8_t));
    for(unsigned i = 0; i < work.size(); ++i ) {
      work_char[i/2] += atoi(&work[i])<<(4*(i%2));
    }
    //memcpy(work_char,work.c_str(),work.size()*sizeof(uint8_t)/2);
    
    blake2b_init(&cpu.state,BLAKE2B_OUTBYTES);
    blake2b_update(&cpu.state,empty_cpu,the_thing.size());
    blake2b_final(&cpu.state,hash_cpu,BLAKE2B_OUTBYTES);

    std::cout << BLAKE2B_OUTBYTES << std::endl;

    std::cout << "input work: 0x";
    for( unsigned i = 0; i < BLAKE2B_OUTBYTES ; ++i ) {
      std::cout << std::hex << (unsigned)(work_char[i]>>4) << (unsigned)(work_char[i]&0xf);
    }
    std::cout << std::endl;
    
    std::cout << "cpu: " << uint32_t(cpu.state.buflen) << " trial = 0x" << std::hex;
    // output "blake2bl"
    for( unsigned i = 32; i < BLAKE2B_OUTBYTES ; ++i ) {
    	 std::cout << std::hex << (unsigned)(hash_cpu[i]>>4) << (unsigned)(hash_cpu[i]&0xf);
    }   
    std::cout << std::dec << std::endl;
    double dist_cpu = cosine_distance_cu(work_char,hash_cpu);
    std::cout << "cpu distance is: " << dist_cpu << std::endl;

    blake2b_init_cu(&gpu.state,BLAKE2B_OUTBYTES);
    blake2b_update_cu(&gpu.state,empty_gpu,the_thing.size());
    blake2b_final_cu(&gpu.state,hash_gpu,BLAKE2B_OUTBYTES);
    std::cout << "gpu: " << uint32_t(gpu.state.buflen) << " trial = 0x" << std::hex;
    // output "blake2bl"
    for( unsigned i = 32; i < BLAKE2B_OUTBYTES ; ++i ) {
    	 std::cout << std::hex << (unsigned)(hash_gpu[i]>>4) << (unsigned)(hash_gpu[i]&0xf);
    }
    std::cout << std::dec << std::endl;
    double dist_gpu = cosine_distance_cu(work_char,hash_gpu);
    std::cout << "gpu distance is: " << dist_gpu << std::endl;
    
    return 0;
}
