// cosine distance implementation for blockcollider
// lgray@github September 2018
// permission granted to use under MIT license

#include <iostream>

__host__ double cosine_distance_cu(uint8_t work[BLAKE2B_OUTBYTES],
                                   uint8_t comp[BLAKE2B_OUTBYTES],
                                   size_t bytes_size=BLAKE2B_OUTBYTES) {

  static uint16_t num_to_code[16] = {48,49,50,51,52,53,54,55,56,57,97,98,99,100,101,102};
  
  double acc = 0;  
  for(unsigned j = 2; j < BLAKE2B_OUTBYTES/16; ++j) {
    double den = 0; 
    uint32_t jwork1(0), jwork2(0), jcomp1(0), jcomp2(0);
    uint64_t num(0),norm_work(0),norm_comp(0);
    for( unsigned i = 0; i < 16; ++i ) {      
      unsigned offset_fwd = 16*j + i;      
      unsigned offset_bkw = (16*(4-j-1)) + i;
      unsigned work_lcl = work[offset_bkw];
      unsigned comp_lcl = comp[offset_fwd];
      jwork2 = num_to_code[work_lcl&0xf];
      jcomp2 = num_to_code[comp_lcl&0xf];
      jwork1 = num_to_code[(work_lcl>>4)&0xf];
      jcomp1 = num_to_code[(comp_lcl>>4)&0xf];
      num += (jwork1*jcomp1 + jwork2*jcomp2);
      norm_work += (jwork1*jwork1 + jwork2*jwork2);
      norm_comp += (jcomp1*jcomp1 + jcomp2*jcomp2);
    }
    den = std::sqrt(double(norm_work))*std::sqrt(double(norm_comp));
    acc += (1.0-num/den);
  }  
  return acc*1e15;
}
