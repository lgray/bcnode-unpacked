#include "blake2.h"
#include "bc_miner.cu"

#include <string>
#include <vector>
#include <algorithm>
#include <ctime>

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
    BCHash cpu = BCHash();
    BCHash gpu = BCHash();

    std::string work("0edd781347cfc9c3ff49fdc423c7f1a3deae6501e5cef6b99c45c8901f763320");
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
      char temp[2];
      temp[0] = work[i];
      temp[1] = '\0';
      work_char[i/2] += strtol(temp,NULL,16)<<(4*((i+1)%2));
    }
    //memcpy(work_char,work.c_str(),work.size()*sizeof(uint8_t)/2);
    
    std::time_t begin = time(0);

    bc_mining_data* testhost = NULL;
    testhost = (bc_mining_data*)malloc(sizeof(bc_mining_data));
    memset(testhost,0,sizeof(bc_mining_data));

    for(unsigned long long i = 0; i < 1; ++i ) {    
      blake2b_init(&cpu.state,BLAKE2B_OUTBYTES);
      blake2b_update(&cpu.state,empty_cpu,the_thing.size());
      blake2b_final(&cpu.state,hash_cpu,BLAKE2B_OUTBYTES);
    }

    std::time_t end = time(0);
    double elapsed_secs = double(end - begin);
    
    std::cout<< "cpu took clocks: " << elapsed_secs*1000 << std::endl;

    std::cout << BLAKE2B_OUTBYTES << ' ' << work_char << std::endl;

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
    std::cout << "cpu distance is: " << (unsigned long long)(dist_cpu) << std::endl;

    // now let's do it on the GPU for real
    size_t stash_size = mhash.length();
    size_t tstamp_size = times.length();
    /*
    cudaMemcpyToSymbol(time_stamp_size_, &tstamp_size, sizeof(size_t));
    cudaMemcpyToSymbol(time_stamp_, times.c_str(), times.length());
    cudaMemcpyToSymbol(miner_key_size_, &stash_size, sizeof(size_t));
    cudaMemcpyToSymbol(miner_key_, mhash.c_str(), mhash.length());
    cudaMemcpyToSymbol(received_work_, work_char, BLAKE2B_OUTBYTES);
    cudaMemcpyToSymbol(merkle_root_,merkl.c_str(), BLAKE2B_OUTBYTES);
    */

    //random numbers
    curandState *devStates;
    cudaMalloc((void **)&devStates, HASH_TRIES * 1 * sizeof(curandState));

    bc_mining_data* testdev = NULL;
    uint16_t work_size = mhash.length() + 2*BLAKE2B_OUTBYTES + times.size();
    uint16_t nonce_hash_offset = mhash.length() + BLAKE2B_OUTBYTES;
    cudaMalloc(&testdev,sizeof(bc_mining_data));     
    cudaMemset(testdev,0,sizeof(bc_mining_data));
    // set common thread data (mostly in case we need it later now...    
    cudaMemcpy(&testdev->time_stamp_size_, &tstamp_size, sizeof(size_t), cudaMemcpyHostToDevice);
    cudaMemcpy(testdev->time_stamp_, times.c_str(), times.length(), cudaMemcpyHostToDevice);
    cudaMemcpy(&testdev->miner_key_size_, &stash_size, sizeof(size_t), cudaMemcpyHostToDevice);
    cudaMemcpy(testdev->miner_key_, mhash.c_str(), mhash.length(), cudaMemcpyHostToDevice);
    cudaMemcpy(testdev->received_work_, work_char, BLAKE2B_OUTBYTES, cudaMemcpyHostToDevice);
    cudaMemcpy(testdev->merkle_root_,merkl.c_str(), BLAKE2B_OUTBYTES, cudaMemcpyHostToDevice);
        
    //setup the work template
    cudaMemset(testdev->work_template_,0,bc_mining_data::INLENGTH);
    cudaMemcpy(&testdev->nonce_hash_offset_,&nonce_hash_offset,sizeof(uint16_t),cudaMemcpyHostToDevice);
    cudaMemcpy(&testdev->work_size_,&work_size,sizeof(uint16_t),cudaMemcpyHostToDevice);
    unsigned index = 0;
    cudaMemcpy(testdev->work_template_,testdev->miner_key_,mhash.length(),cudaMemcpyDeviceToDevice);
    index += mhash.length();
    cudaMemcpy(testdev->work_template_+index,testdev->merkle_root_,BLAKE2B_OUTBYTES,cudaMemcpyDeviceToDevice);
    index += 2*BLAKE2B_OUTBYTES; //advance past nonce hash area
    cudaMemcpy(testdev->work_template_+index,testdev->time_stamp_,times.length(),cudaMemcpyDeviceToDevice);
    index += times.length();

    //setup test information
    /*
 m,/
    cudaMemcpy(&testdev->nonce[0],&thenonce,sizeof(uint32_t),cudaMemcpyHostToDevice);
    for(unsigned long long i = 1; i < HASH_TRIES; ++i ) {
      cudaMemcpy(&testdev->nonce[i],&testdev->nonce[0],sizeof(uint32_t),cudaMemcpyDeviceToDevice);
    }
    */
    
    
    std::time_t begin_gpu = time(0);

    dim3 threads(N_MINER_THREADS_PER_BLOCK,1,1), blocks(HASH_TRIES/N_MINER_THREADS_PER_BLOCK,1,1);

    
    setup_rand<<<blocks,threads>>>(devStates);
    //cudaDeviceSynchronize();
    prepare_work_nonces<<<blocks,threads>>>(devStates,testdev);
    //cudaDeviceSynchronize();
    one_unit_work<<<blocks,threads>>>(testdev);
    //cudaDeviceSynchronize();
    

    std::time_t end_gpu = time(0);
    double elapsed_secs_gpu = double(end_gpu - begin_gpu);
    
    std::cout<< "gpu took clocks: " << elapsed_secs_gpu*1000 << std::endl;

    cudaMemcpy(testhost,testdev,sizeof(bc_mining_data),cudaMemcpyDeviceToHost);
    
    std::cout << "gpu: " << "blep" << " trial = 0x" << std::hex;
    // output "blake2bl"
    for( unsigned i = 32; i < BLAKE2B_OUTBYTES; ++i ) {
    	 std::cout << std::hex << (unsigned)(testhost->result[i]>>4) << (unsigned)(testhost->result[i]&0xf);
    }
    std::cout << std::dec << std::endl;
    std::cout << "gpu distance is: " << testhost->distance[0] << std::endl;

    //unsigned long long dist_gpu = cosine_distance_cu(work_char,hash_gpu);//one_unit_work(work_char,empty_gpu,the_thing.size());
        
    size_t max = 0;
    unsigned long long distance = testhost->distance[0];
    for(unsigned i = 0; i < HASH_TRIES; ++i) {
      if( testhost->distance[i] > distance ) {
	max = i;
	distance = testhost->distance[i];
      }
    }
        
    unsigned offset_first = BLAKE2B_OUTBYTES*max;
    for( unsigned i = 32; i < BLAKE2B_OUTBYTES; ++i ) {
      std::cout << std::hex 
		<< (unsigned)(testhost->result[i+offset_first]>>4)
		<< (unsigned)(testhost->result[i+offset_first]&0xf);
    }
    std::cout << std::dec << std::endl;
    std::cout << "gpu distance is: " << testhost->distance[max] << std::endl;
    
    cudaFree(testdev);
    free(testhost);
    
    return 0;
}
