// Blake2-B Faithful CUDA Implementation
// lgray@github September 2018
// permission granted to use under MIT license
// this is a GPU miner for block collider that does ~ 23M hashes + distances per second

#include "blake2.h"
#include "blake2b.cu"
#include "cos_dist.cu"
#include <curand_kernel.h>
#include "stdio.h"

static const unsigned HASH_TRIES = 1 << 23;
static const unsigned N_MINER_THREADS_PER_BLOCK = 32;

/*
__constant__ uint8_t miner_key_[BLAKE2B_OUTBYTES];
__constant__ uint8_t merkle_root_[BLAKE2B_OUTBYTES];
__constant__ uint8_t received_work_[BLAKE2B_OUTBYTES];
__constant__ uint8_t time_stamp_[BLAKE2B_OUTBYTES];
__constant__ size_t miner_key_size_;
__constant__ size_t time_stamp_size_;
__constant__ unsigned long long the_difficulty_;
*/

struct bc_mining_data {
  static const size_t INLENGTH = 2048;
  uint8_t result[HASH_TRIES*BLAKE2B_OUTBYTES],nonce_hashes[HASH_TRIES*BLAKE2B_OUTBYTES];
  uint64_t distance[HASH_TRIES];
  uint32_t nonce[HASH_TRIES];
  bool over_difficulty[HASH_TRIES];
  // common data
  uint8_t work_template_[INLENGTH]; 
  uint8_t miner_key_[BLAKE2B_OUTBYTES];
  uint8_t merkle_root_[BLAKE2B_OUTBYTES];
  uint8_t received_work_[BLAKE2B_OUTBYTES];
  uint8_t time_stamp_[BLAKE2B_OUTBYTES];
  uint16_t nonce_hash_offset_;
  uint16_t work_size_;
  size_t miner_key_size_;
  size_t time_stamp_size_;
  unsigned long long the_difficulty_;
};

__global__ void setup_rand(curandState* state)
{
  unsigned id = threadIdx.x + blockIdx.x * blockDim.x;
  
  /* Each thread gets same seed, a different sequence 
     number, no offset */
  curand_init(1234^(uint64_t)state + id^4321, 0, 0, &state[id]);
}

//__device__ __host__ __forceinline__ 
__global__
void one_unit_work(bc_mining_data* mining_info) {
  
  unsigned id = threadIdx.x + blockIdx.x *blockDim.x;
  
  uint8_t data_in[bc_mining_data::INLENGTH];
  memset(data_in,0,bc_mining_data::INLENGTH);
  
  const size_t idoffset = id*BLAKE2B_OUTBYTES;
  memcpy(data_in,mining_info->work_template_,mining_info->work_size_);
  memcpy(data_in+mining_info->nonce_hash_offset_,mining_info->nonce_hashes+idoffset,BLAKE2B_OUTBYTES);
  
  blake2b_state s;
  blake2b_init_cu(&s,BLAKE2B_OUTBYTES);  
  blake2b_update_cu(&s,data_in,mining_info->work_size_);
  blake2b_final_cu(&s,mining_info->result+idoffset,BLAKE2B_OUTBYTES);
  
  mining_info->distance[id] = cosine_distance_cu(mining_info->received_work_,
						 mining_info->result+id*BLAKE2B_OUTBYTES);
}

__global__
void prepare_work_nonces(curandState *state, bc_mining_data* mining_info) {

  static uint16_t num_to_code[16] =  {48,49,50,51,52,53,54,55,56,57,97,98,99,100,101,102};  

  static uint64_t powers_of_ten[11] = { 1,
					10,
					100,
					1000,
					10000,
					100000,
					1000000,
					10000000,
					100000000,
					1000000000,
					10000000000};

  unsigned id = threadIdx.x + blockIdx.x * blockDim.x;
    
  curandState localState = state[id];
  uint8_t nonce_string[12]; // ten bytes and a null character max;
  uint8_t nonce_hash[BLAKE2B_OUTBYTES];
  memset(nonce_string,0,12);

  //2060688607;
  uint32_t nonce = curand(&localState);
  
  // convert nonce
  nonce_string[0] = '0'; // take care of base case
  uint32_t length = 0;
  while( nonce >= powers_of_ten[length] ) { ++length; }  
  for( uint32_t i = 0; i < length; ++i ) {
    nonce_string[length-i-1] = num_to_code[(nonce/powers_of_ten[i])%10];
  }
  length = (length == 0) + (length > 0)*length;
  
  //printf("length: %u %u %s\n",length,nonce,nonce_string); 
  
  // create the nonce hash
  blake2b_state ns;
  blake2b_init_cu(&ns,BLAKE2B_OUTBYTES);  
  blake2b_update_cu(&ns,nonce_string,length);
  blake2b_final_cu(&ns,nonce_hash,BLAKE2B_OUTBYTES);
  
  // convert nonce in place to string codes and "blake2bl" form
  #pragma unroll
  for( unsigned i = 32; i < BLAKE2B_OUTBYTES; ++i ) {
    uint8_t byte = nonce_hash[i];
    nonce_hash[2*(i-32)] = num_to_code[byte>>4];
    nonce_hash[2*(i-32)+1] = num_to_code[byte&0xf];
  }
    
  // now we put everything into the data_in string in stringified hex form  
  const size_t idoffset = id*BLAKE2B_OUTBYTES;
  memcpy(mining_info->nonce_hashes+idoffset,
	 nonce_hash,
	 BLAKE2B_OUTBYTES);  

  //copy the local work back to the gpu memory  
  mining_info->nonce[id] = nonce;

  state[id] = localState;
}

__host__ void do_mining(uint8_t work[BLAKE2B_OUTBYTES]) {
  
}

__device__ __host__ void launch_mining(uint8_t work[BLAKE2B_OUTBYTES]) {
  
}
