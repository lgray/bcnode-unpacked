#include "blake2b.cu"
#include "cos_dist.cu"

#include <string>

__device__ __host__ __forceinline__ unsigned long long
one_unit_work(uint8_t work[BLAKE2B_OUTBYTES],
              uint8_t compare[1024],
              size_t compare_size) {
  blake2b_state s;
  uint8_t eph_hash[BLAKE2B_OUTBYTES];
  
  blake2b_init_cu(&s,BLAKE2B_OUTBYTES);  
  blake2b_update_cu(&s,compare,compare_size);
  blake2b_final_cu(&s,eph_hash,BLAKE2B_OUTBYTES);
  
  return cosine_distance_cu(work,eph_hash);
}

__device__ __host__ 
void prepare_comparison(const std::string&) {
  
}

__device__ __host__ void launch_mining(uint8_t work[BLAKE2B_OUTBYTES]) {
}
