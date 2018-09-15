#include "blake2.h"
#include "blake2b.cu"
#include "cos_dist.cu"
#include <curand_kernel.h>
#include "stdio.h"

static const unsigned N_MINER_THREADS_PER_BLOCK = 64;

__constant__ uint8_t miner_key_[BLAKE2B_OUTBYTES];
__constant__ uint8_t merkle_root_[BLAKE2B_OUTBYTES];
__constant__ uint8_t received_work_[BLAKE2B_OUTBYTES];
__constant__ uint8_t time_stamp_[BLAKE2B_OUTBYTES];
__constant__ size_t miner_key_size_;
__constant__ size_t time_stamp_size_;
__constant__ unsigned long long the_difficulty_;


struct bc_mining_data {
  static const size_t INLENGTH = 2048;
  uint8_t result[BLAKE2B_OUTBYTES], data_in[INLENGTH];
  uint64_t distance;
  uint32_t nonce;
  size_t data_size;
  bool over_difficulty;
};

__global__ void setup_rand(curandState *state)
{
  int id = threadIdx.x + blockIdx.x * N_MINER_THREADS_PER_BLOCK;
  /* Each thread gets same seed, a different sequence 
     number, no offset */
  curand_init(1234^(uint64_t)state, id, 0, &state[id]);
}

//__device__ __host__ __forceinline__ 
__global__
void one_unit_work(bc_mining_data* mining_info) {

  uint8_t received_work[BLAKE2B_OUTBYTES];
  memcpy(received_work,received_work_,BLAKE2B_OUTBYTES);

  int id = threadIdx.x + blockIdx.x * N_MINER_THREADS_PER_BLOCK;
  
  bc_mining_data mine_this;
  memcpy(&mine_this,&mining_info[id],sizeof(bc_mining_data));

  blake2b_state s;
  blake2b_init_cu(&s,BLAKE2B_OUTBYTES);  
  blake2b_update_cu(&s,mine_this.data_in,mine_this.data_size);
  blake2b_final_cu(&s,mine_this.result,BLAKE2B_OUTBYTES);
  
  mine_this.distance = cosine_distance_cu(received_work,mine_this.result);

  memcpy(&mining_info[id],&mine_this,sizeof(bc_mining_data));
}

__global__
void prepare_work(curandState *state, bc_mining_data* mining_info) {

  size_t miner_key_size,tstamp_size;
  uint8_t tstamp[BLAKE2B_OUTBYTES],miner_key[BLAKE2B_OUTBYTES],merkle_root[BLAKE2B_OUTBYTES];
  memcpy(&tstamp_size,&time_stamp_size_,sizeof(size_t));  
  memcpy(tstamp,time_stamp_,time_stamp_size_);
  memcpy(&miner_key_size,&miner_key_size_,sizeof(size_t));  
  memcpy(miner_key,miner_key_,miner_key_size);
  memcpy(merkle_root,merkle_root_,BLAKE2B_OUTBYTES);

  static uint16_t num_to_code[16] = {48,49,50,51,52,53,54,55,56,57,97,98,99,100,101,102};
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
					
  
  int id = threadIdx.x + blockIdx.x * N_MINER_THREADS_PER_BLOCK;

  
  
  bc_mining_data mine_this;
  memcpy(&mine_this,&mining_info[id],sizeof(bc_mining_data));  
  curandState localState = state[id];
  uint8_t nonce_string[12]; // ten bytes and a null character max;
  uint8_t nonce_hash[BLAKE2B_OUTBYTES];
  memset(nonce_string,0,12);
  
  //uint32_t temp = curand(&localState);
  mine_this.nonce = curand(&localState);
  
  // convert nonce
  nonce_string[0] = '0'; // take care of base case
  uint32_t length = 0;
  while( mine_this.nonce >= powers_of_ten[length] ) { ++length; }
  for( uint32_t i = 0; i < length; ++i ){    
    nonce_string[length-i-1] = num_to_code[(mine_this.nonce/powers_of_ten[i])%10];
  }

  // create the nonce hash
  blake2b_state ns;
  blake2b_init_cu(&ns,BLAKE2B_OUTBYTES);  
  blake2b_update_cu(&ns,nonce_string,length);
  blake2b_final_cu(&ns,nonce_hash,BLAKE2B_OUTBYTES);

  // convert nonce in place to string codes and "blake2bl" form
  for( unsigned i = 32; i < BLAKE2B_OUTBYTES; ++i ) {
    uint8_t byte = nonce_hash[i];
    nonce_hash[2*(i-32)] = num_to_code[byte>>4];
    nonce_hash[2*(i-32)+1] = num_to_code[byte&0xf];
  }
  
  // now we put everything into the data_in string in stringified hex form
  uint32_t index = 0;
  memcpy(mine_this.data_in,miner_key,miner_key_size);
  index += miner_key_size;  
  memcpy(mine_this.data_in+index,merkle_root,BLAKE2B_OUTBYTES);
  index += BLAKE2B_OUTBYTES;
  memcpy(mine_this.data_in+index,nonce_hash,BLAKE2B_OUTBYTES);
  index += BLAKE2B_OUTBYTES;
  memcpy(mine_this.data_in+index,tstamp,tstamp_size);
  index += tstamp_size;
  mine_this.data_size = index;

  //copy the local work back to the gpu memory
  memcpy(&mining_info[id],&mine_this,sizeof(bc_mining_data));

  state[id] = localState;
}

__host__ void do_mining(uint8_t work[BLAKE2B_OUTBYTES]) {
  
}

__device__ __host__ void launch_mining(uint8_t work[BLAKE2B_OUTBYTES]) {
  
}
